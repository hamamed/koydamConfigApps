import express from 'express';
import multer from 'multer';

import { config } from '../config.js';
import { db } from '../db/index.js';
import { adoptPastedIslands, backfillIslandArt, syncIslandMetrics, syncIslands } from '../ecosystem.js';
import { internalAccess } from '../internal-auth.js';
import { parseMaps } from '../maps-import.js';
import { blockClient, moderationSummary, unblockClient } from '../reactions.js';
import { clearSetting, maskedSetting, setSetting, settingUpdatedAt } from '../settings.js';
import { SHOWCASE_ROOT, showcaseClips } from '../showcase.js';
import { MAX_CLIP_BYTES, createClipStore } from '../showcase-store.js';
import { STATS_KEY, playerStats, statsSummary } from '../stats.js';
import { syncCosmetics, syncNews, syncShop } from '../upstream.js';
import { parseWeapons } from '../weapons-import.js';

/**
 * Control routes for the Koydam control panel.
 *
 * The panel holds a copy of this service's content, but the engine stays
 * here: fetching from Epic, the showcase clips, the islands crawl, player
 * stats and reactions. These routes let the panel drive that engine with the
 * same functions the admin pages call, so there is one implementation and two
 * places to press the button. JSON in, JSON out; see internal-auth.js for who
 * may call them.
 */
export const internalRouter = express.Router();

const ISLAND_PAGE = 50;
const MAX_CLIP_FILES = 10;
const SORTS = {
  popular: 'peak_ccu IS NULL, peak_ccu DESC, title COLLATE NOCASE',
  players: 'unique_players IS NULL, unique_players DESC, title COLLATE NOCASE',
  plays: 'plays IS NULL, plays DESC, title COLLATE NOCASE',
  name: 'title COLLATE NOCASE',
};

internalRouter.use((req, res, next) => {
  const access = internalAccess(req.headers, process.env.PANEL_TOKEN);
  if (access === 'ok') return next();
  // "Not found" for everything else: an outsider learns nothing about what is here.
  return res.status(access === 'denied' ? 401 : 404).json({ ok: false, error: access === 'denied' ? 'Not authorised.' : 'Not found.' });
});

const ok = (res, data) => res.json({ ok: true, data });
const fail = (res, status, error) => res.status(status).json({ ok: false, error });

// ── Fetch one feed from the game now ────────────────────────────────────────

const JOBS = {
  cosmetics: syncCosmetics,
  shop: syncShop,
  news: syncNews,
  islands: async () => {
    const n = await syncIslands({ pages: 40 });
    await adoptPastedIslands();
    backfillIslandArt();
    return n;
  },
  'island-metrics': () => syncIslandMetrics({
    batch: config.refresh.metricsBatch,
    exploreShare: config.refresh.metricsExploreShare,
    concurrency: config.refresh.metricsConcurrency,
  }),
};

internalRouter.post('/sync/:feed', async (req, res) => {
  const job = JOBS[req.params.feed];
  if (!job) return fail(res, 404, 'Unknown feed.');
  try {
    return ok(res, { feed: req.params.feed, records: await job() });
  } catch (err) {
    return fail(res, 502, `Could not refresh ${req.params.feed}: ${err.message}`);
  }
});

// ── Showcase clips ──────────────────────────────────────────────────────────

const clipStore = createClipStore(SHOWCASE_ROOT, {
  isKnownId: (id) => Boolean(db.prepare('SELECT 1 FROM cosmetics WHERE id = ?').get(id)),
});
const uploadClips = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CLIP_BYTES, files: MAX_CLIP_FILES },
}).array('file', MAX_CLIP_FILES);

internalRouter.post('/videos', (req, res) => {
  uploadClips(req, res, async (err) => {
    if (err) {
      const reason = err.code === 'LIMIT_FILE_SIZE'
        ? `One of those files is larger than ${Math.round(MAX_CLIP_BYTES / 1024 / 1024)} MB.`
        : err.code === 'LIMIT_FILE_COUNT'
          ? `That is more than ${MAX_CLIP_FILES} files.`
          : 'That upload could not be read.';
      return fail(res, 400, reason);
    }
    const stored = [];
    const failed = [];
    // One at a time, and a bad file does not sink the rest.
    for (const file of req.files ?? []) {
      const result = await clipStore.storeClip({ buffer: file.buffer, filename: file.originalname });
      if (result.ok) stored.push({ id: result.id, replaced: result.replaced });
      else failed.push({ name: file.originalname, reason: result.reason });
    }
    if (stored.length) await showcaseClips.reload();
    return ok(res, { stored, failed });
  });
});

internalRouter.delete('/videos/:id', async (req, res) => {
  const result = await clipStore.deleteClip(String(req.params.id));
  if (!result.ok) return fail(res, 400, result.reason);
  await showcaseClips.reload();
  return ok(res, { id: result.id });
});

// ── Paste importers: read only. The panel shows the result and saves it. ────

internalRouter.post('/parse/weapons', (req, res) => {
  ok(res, parseWeapons(String(req.body?.text ?? ''), { includeVaulted: req.body?.vaulted === true }));
});

internalRouter.post('/parse/maps', (req, res) => {
  const parsed = parseMaps(String(req.body?.text ?? ''));
  // Artwork Epic never ships: reuse what an earlier paste attached to the island.
  const art = db.prepare('SELECT image_url FROM islands WHERE code = ?');
  const rows = parsed.rows.map((row) => ({ ...row, image_url: row.image_url ?? art.get(row.code)?.image_url ?? null }));
  ok(res, { ...parsed, rows });
});

// ── Islands ─────────────────────────────────────────────────────────────────

internalRouter.get('/islands', (req, res) => {
  const search = String(req.query.search ?? '').trim().toLowerCase().slice(0, 100);
  const where = [];
  const params = {};
  if (search) {
    where.push('search_blob LIKE @search');
    params.search = `%${search}%`;
  }
  if (req.query.measured === '1') where.push('peak_ccu IS NOT NULL');
  if (req.query.art === '1') where.push('image_url IS NOT NULL');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const page = Math.max(1, Math.min(Number.parseInt(req.query.page, 10) || 1, 10_000));
  const order = SORTS[req.query.sort] ?? SORTS.popular;

  const rows = db
    .prepare(
      `SELECT code, title, creator_code, category, image_url, peak_ccu, unique_players, plays,
              minutes_played, favorites, avg_minutes, metrics_at
         FROM islands ${clause}
        ORDER BY ${order}
        LIMIT ${ISLAND_PAGE} OFFSET ${(page - 1) * ISLAND_PAGE}`,
    )
    .all(params);
  const matched = db.prepare(`SELECT COUNT(*) AS n FROM islands ${clause}`).get(params).n;
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(peak_ccu IS NOT NULL) AS measured,
              SUM(image_url IS NOT NULL) AS withArt
         FROM islands`,
    )
    .get();

  ok(res, { rows, matched, page, pageSize: ISLAND_PAGE, totals, history: db.prepare('SELECT COUNT(*) AS n FROM island_metrics').get().n });
});

internalRouter.get('/islands/:code', (req, res) => {
  const code = String(req.params.code);
  const island = db.prepare('SELECT * FROM islands WHERE code = ?').get(code);
  if (!island) return fail(res, 404, 'No such island.');
  const days = db
    .prepare(
      `SELECT day, peak_ccu, unique_players, plays, minutes_played, favorites,
              recommendations, avg_minutes, retention
         FROM island_metrics WHERE code = ? ORDER BY day ASC`,
    )
    .all(code);
  return ok(res, { island, days });
});

// ── Player stats ────────────────────────────────────────────────────────────

internalRouter.get('/stats', (_req, res) => {
  ok(res, { masked: maskedSetting(STATS_KEY), updatedAt: settingUpdatedAt(STATS_KEY), summary: statsSummary() });
});

internalRouter.get('/stats/lookup', async (req, res) => {
  try {
    return ok(res, await playerStats(String(req.query.name ?? '')));
  } catch (err) {
    return fail(res, err.status >= 400 && err.status < 500 ? err.status : 502, err.message);
  }
});

internalRouter.post('/stats/key', (req, res) => {
  const key = String(req.body?.key ?? '').trim();
  if (!key) return fail(res, 400, 'Paste a key.');
  setSetting(STATS_KEY, key);
  return ok(res, { masked: maskedSetting(STATS_KEY) });
});

internalRouter.delete('/stats/key', (_req, res) => {
  clearSetting(STATS_KEY);
  ok(res, { masked: null });
});

// ── Reactions ───────────────────────────────────────────────────────────────

internalRouter.get('/reactions', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT r.item_id, COUNT(*) AS total, COALESCE(c.name, r.item_id) AS name, c.rarity,
              MAX(r.updated_at) AS latest
         FROM reactions r LEFT JOIN cosmetics c ON c.id = r.item_id
        GROUP BY r.item_id ORDER BY total DESC, latest DESC LIMIT 100`,
    )
    .all();
  const byKind = db.prepare('SELECT kind, COUNT(*) AS n FROM reactions GROUP BY kind ORDER BY n DESC').all();
  const devices = db
    .prepare(
      `SELECT client_key AS key, COUNT(*) AS reactions, MAX(updated_at) AS latest
         FROM reactions GROUP BY client_key ORDER BY reactions DESC, latest DESC LIMIT 100`,
    )
    .all();
  const blocked = db.prepare('SELECT client_key AS key, reason, created_at FROM blocked_clients ORDER BY created_at DESC LIMIT 200').all();
  ok(res, { rows, byKind, devices, blocked, summary: moderationSummary() });
});

internalRouter.post('/reactions/block', (req, res) => {
  const key = String(req.body?.key ?? '').trim();
  if (!key) return fail(res, 400, 'No device given.');
  if (req.body?.action === 'unblock') unblockClient(key);
  else blockClient(key, 'blocked from the control panel');
  return ok(res, { key, blocked: req.body?.action !== 'unblock' });
});
