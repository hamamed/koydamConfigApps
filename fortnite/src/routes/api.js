import { Router } from 'express';

import { config } from '../config.js';
import { db } from '../db/index.js';
import { syncStatus } from '../upstream.js';

export const apiRouter = Router();

const ok = (res, data, meta) => res.json({ status: 'success', data, ...(meta ? { meta } : {}) });

const clamp = (value, fallback, max) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
};

/**
 * The shop rotates at midnight UTC, every day.
 *
 * Computed rather than read off an offer's `outDate`: those are per-offer and a
 * long-running bundle can sit in the shop for a week, so the earliest one is
 * not the rotation and the latest is not either. The app counts down to this.
 */
function nextRotation() {
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
  return next.toISOString();
}

apiRouter.get('/health', (_req, res) => {
  const feeds = syncStatus();
  const stale = feeds.filter((f) => f.last_error);
  res.json({
    status: 'success',
    data: {
      ok: true,
      time: new Date().toISOString(),
      feeds,
      degraded: stale.map((f) => f.feed),
    },
  });
});

/**
 * `GET /cosmetics` — the catalogue, paginated and filtered.
 *
 * Every filter is applied in SQL. Sixteen thousand items is small for SQLite
 * and enormous for a phone, and the whole reason this service exists is that
 * the upstream catalogue is one 16 MB document with no way to ask it a
 * question.
 */
apiRouter.get('/cosmetics', (req, res) => {
  const limit = clamp(req.query.limit, config.defaultPageSize, config.maxPageSize);
  const page = clamp(req.query.page, 1, 10_000);

  const where = [];
  const params = {};

  // Repeatable filters: ?type=outfit&type=pickaxe. Express gives a string for
  // one and an array for several, so both are normalised to an array.
  for (const [field, column] of [['type', 'type'], ['rarity', 'rarity'], ['series', 'series']]) {
    const raw = req.query[field];
    if (raw == null) continue;
    const values = (Array.isArray(raw) ? raw : [raw]).map((v) => String(v)).filter(Boolean);
    if (!values.length) continue;
    const keys = values.map((v, i) => {
      params[`${field}${i}`] = v;
      return `@${field}${i}`;
    });
    where.push(`${column} IN (${keys.join(', ')})`);
  }

  const search = String(req.query.search ?? '').trim().toLowerCase();
  if (search) {
    where.push('search_blob LIKE @search');
    params.search = `%${search}%`;
  }

  if (req.query.season) {
    where.push('season = @season');
    params.season = String(req.query.season);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Newest first by default. NULLs last, because thousands of early items have
  // no `added` date and would otherwise fill the first page.
  const order =
    String(req.query.sort ?? 'newest') === 'name'
      ? 'name COLLATE NOCASE ASC'
      : 'added_at IS NULL, added_at DESC, name COLLATE NOCASE ASC';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM cosmetics ${clause}`).get(params).n;
  const rows = db
    .prepare(
      `SELECT id, name, description, type, type_name, rarity, rarity_name, series,
              set_name, introduction, season, icon_url, featured_url, small_icon_url, added_at
         FROM cosmetics ${clause}
        ORDER BY ${order}
        LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset: (page - 1) * limit });

  ok(res, rows.map(toApiShape), {
    page,
    limit,
    total,
    hasMore: page * limit < total,
  });
});

apiRouter.get('/cosmetics/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM cosmetics WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ status: 'error', message: 'Cosmetic not found' });

  // "More from this set" is the one thing a detail screen always wants and the
  // list endpoint cannot answer without the item in hand.
  const related = row.set_name
    ? db
        .prepare(
          `SELECT id, name, type, rarity, series, icon_url FROM cosmetics
            WHERE set_name = ? AND id != ? ORDER BY name COLLATE NOCASE LIMIT 12`,
        )
        .all(row.set_name, row.id)
    : [];

  ok(res, { ...toApiShape(row), related: related.map(toApiShape) });
});

/** The filter pills the app draws, with counts, so it never offers an empty filter. */
apiRouter.get('/filters', (_req, res) => {
  const group = (column) =>
    db
      .prepare(
        `SELECT ${column} AS value, COUNT(*) AS count FROM cosmetics
          WHERE ${column} IS NOT NULL AND ${column} != ''
          GROUP BY ${column} ORDER BY count DESC`,
      )
      .all();

  ok(res, { types: group('type'), rarities: group('rarity'), series: group('series') });
});

apiRouter.get('/shop', (_req, res) => {
  const rows = db
    .prepare('SELECT * FROM shop_entries ORDER BY sort_priority DESC, layout_name, offer_id')
    .all();

  const entries = rows.map((row) => ({
    offerId: row.offer_id,
    regularPrice: row.regular_price,
    finalPrice: row.final_price,
    discounted: row.final_price < row.regular_price,
    giftable: Boolean(row.giftable),
    layout: row.layout_name,
    tileSize: row.tile_size,
    inDate: row.in_date,
    outDate: row.out_date,
    items: JSON.parse(row.items_json),
  }));

  ok(res, {
    date: rows[0]?.shop_date ?? null,
    resetsAt: nextRotation(),
    entries,
  });
});

apiRouter.get('/news', (_req, res) => {
  const rows = db.prepare('SELECT * FROM news ORDER BY priority DESC, id').all();
  ok(
    res,
    rows.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      tabTitle: r.tab_title,
      image: r.image_url,
      tile: r.tile_url,
    })),
  );
});

apiRouter.get('/leaks', (_req, res) => {
  const rows = db
    .prepare('SELECT * FROM leaks WHERE is_published = 1 ORDER BY created_at DESC LIMIT 60')
    .all();
  ok(res, rows.map((r) => ({
    id: r.id, title: r.title, body: r.body, image: r.image_url,
    source: r.source, at: r.created_at,
  })));
});

apiRouter.get('/creative-maps', (_req, res) => {
  const rows = db
    .prepare('SELECT * FROM creative_maps WHERE is_published = 1 ORDER BY sort_order, id DESC')
    .all();
  ok(res, rows.map((r) => ({
    id: r.id, title: r.title, code: r.code, category: r.category,
    description: r.description, image: r.image_url, players: r.players,
  })));
});

apiRouter.get('/weapons', (_req, res) => {
  const rows = db
    .prepare('SELECT * FROM weapons WHERE is_published = 1 ORDER BY sort_order, name')
    .all();
  ok(res, rows.map((r) => ({
    id: r.id, name: r.name, rarity: r.rarity, category: r.category,
    dps: r.dps, damage: r.damage, fireRate: r.fire_rate, magazine: r.magazine,
    reloadTime: r.reload_time, image: r.image_url, description: r.description,
  })));
});

/**
 * `GET /islands` — Epic's creative catalogue, searchable and sortable.
 *
 * Both of which the upstream cannot do: it accepts every such parameter and
 * ignores all of them, which is the reason this mirror exists.
 */
apiRouter.get('/islands', (req, res) => {
  const limit = clamp(req.query.limit, config.defaultPageSize, config.maxPageSize);
  const page = clamp(req.query.page, 1, 10_000);

  const where = [];
  const params = {};

  const search = String(req.query.search ?? '').trim().toLowerCase();
  if (search) {
    where.push('search_blob LIKE @search');
    params.search = `%${search}%`;
  }

  if (req.query.tag) {
    // Tags are stored as a JSON array; a LIKE on the quoted value matches a
    // whole tag rather than a fragment of a longer one.
    where.push('tags LIKE @tag');
    params.tag = `%"${String(req.query.tag).toLowerCase()}"%`;
  }

  // Nulls last, never excluded.
  //
  // Epic publishes numbers for a small fraction of the catalogue, so filtering
  // to "has metrics" made every search return nothing — the four islands with
  // data almost never match what someone typed. Sorting them to the back gives
  // the busy islands first when browsing and still finds everything else.
  const sort = String(req.query.sort ?? 'players');
  const ordering = {
    players: 'peak_ccu IS NULL, peak_ccu DESC',
    plays: 'plays IS NULL, plays DESC',
    minutes: 'minutes_played IS NULL, minutes_played DESC',
    favorites: 'favorites IS NULL, favorites DESC',
    name: 'title COLLATE NOCASE ASC',
    newest: 'first_seen DESC',
  }[sort] ?? 'peak_ccu IS NULL, peak_ccu DESC';

  // Browsing by popularity with nothing else asked for is the one case where
  // pages of unmeasured islands are noise rather than results.
  if (req.query.measured === '1') where.push('peak_ccu IS NOT NULL');

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM islands ${clause}`).get(params).n;

  const rows = db
    .prepare(
      `SELECT code, title, creator_code, category, created_in, tags, image_url, first_seen,
              peak_ccu, unique_players, plays, minutes_played, favorites, recommendations,
              avg_minutes, retention, metrics_at
         FROM islands ${clause}
        ORDER BY ${ordering}
        LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset: (page - 1) * limit });

  ok(res, rows.map(toIslandShape), { page, limit, total, hasMore: page * limit < total });
});

/** `GET /islands/:code` — one island, with whatever history has been kept. */
apiRouter.get('/islands/:code', (req, res) => {
  const row = db.prepare('SELECT * FROM islands WHERE code = ?').get(req.params.code);
  if (!row) return res.status(404).json({ status: 'error', message: 'Island not found' });

  const history = db
    .prepare(
      `SELECT day, peak_ccu, unique_players, plays, minutes_played, avg_minutes,
              favorites, recommendations, retention
         FROM island_metrics WHERE code = ? ORDER BY day DESC LIMIT 200`,
    )
    .all(row.code);

  ok(res, {
    ...toIslandShape(row),
    history: history.map((h) => ({
      day: h.day,
      peakCCU: h.peak_ccu,
      uniquePlayers: h.unique_players,
      plays: h.plays,
      minutesPlayed: h.minutes_played,
      averageMinutes: h.avg_minutes,
      favorites: h.favorites,
      recommendations: h.recommendations,
      retention: h.retention,
    })),
  });
});

/** The tags the catalogue actually uses, for the app's filter row. */
apiRouter.get('/island-tags', (_req, res) => {
  const counts = new Map();
  for (const row of db.prepare('SELECT tags FROM islands').all()) {
    let tags = [];
    try { tags = JSON.parse(row.tags); } catch { tags = []; }
    for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }

  ok(res, [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 40));
});

/**
 * SQLite's `datetime('now')` to ISO 8601.
 *
 * It stores `2026-09-01 12:34:56` — a space, no zone — which is not ISO 8601
 * and which a strict client decoder rejects outright. The values are UTC, so
 * this says so explicitly rather than leaving the client to assume.
 */
function isoDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (text.includes('T')) return text;
  // A bare date has no time to mark as UTC; appending Z to one produces
  // `2026-09-01Z`, which is not a valid instant and decodes nowhere.
  if (!text.includes(' ')) return text;
  return `${text.replace(' ', 'T')}Z`;
}

function toIslandShape(row) {
  let tags = [];
  try { tags = JSON.parse(row.tags ?? '[]'); } catch { tags = []; }

  return {
    code: row.code,
    title: row.title,
    creator: row.creator_code ?? null,
    category: row.category ?? null,
    createdIn: row.created_in ?? null,
    tags,
    image: row.image_url ?? null,
    // Not a publish date. Epic exposes neither created nor updated, so this is
    // when this service first saw the island, and it is named to say so.
    firstSeen: isoDate(row.first_seen),
    // Null where Epic publishes nothing, which is most of the catalogue — the
    // app draws those without numbers rather than showing zeroes.
    peakCCU: row.peak_ccu,
    uniquePlayers: row.unique_players,
    plays: row.plays,
    minutesPlayed: row.minutes_played,
    favorites: row.favorites,
    recommendations: row.recommendations,
    averageMinutes: row.avg_minutes,
    retention: row.retention,
    metricsAt: isoDate(row.metrics_at),
  };
}

/** One shape for a cosmetic, everywhere it appears. */
function toApiShape(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    type: row.type,
    typeName: row.type_name ?? null,
    rarity: row.rarity,
    rarityName: row.rarity_name ?? null,
    series: row.series ?? null,
    set: row.set_name ?? null,
    introduction: row.introduction ?? null,
    season: row.season ?? null,
    icon: row.icon_url ?? null,
    featured: row.featured_url ?? null,
    smallIcon: row.small_icon_url ?? null,
    added: row.added_at ?? null,
  };
}
