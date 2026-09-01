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

apiRouter.get('/wallpapers', (_req, res) => {
  const rows = db
    .prepare('SELECT * FROM wallpapers WHERE is_published = 1 ORDER BY sort_order, id DESC')
    .all();
  ok(res, rows.map((r) => ({
    id: r.id, title: r.title, image: r.image_url, thumb: r.thumb_url ?? r.image_url,
  })));
});

apiRouter.get('/creative-maps', (_req, res) => {
  const rows = db
    .prepare('SELECT * FROM creative_maps WHERE is_published = 1 ORDER BY sort_order, id DESC')
    .all();
  ok(res, rows.map((r) => ({
    id: r.id, title: r.title, code: r.code, category: r.category,
    description: r.description, image: r.image_url,
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
