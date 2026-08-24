import { Router } from 'express';

import { isDbEnabled } from '../db/pool.js';
import {
  brawlerHistory,
  playerHistory,
  pooledMaps,
  pooledStandings,
  topMovers,
} from '../db/meta_repo.js';
import { wilsonLowerBound } from '../crawler/meta_crawler.js';
import { normaliseTag } from '../transform/player.js';

/**
 * Historical meta, backed by Postgres.
 *
 * The one thing the app genuinely cannot compute for itself. Everything else it
 * shows is either a passthrough of a live endpoint or derived on-device from
 * the user's own battles; a brawler's win rate six weeks ago exists only
 * because this service has been recording it.
 */
export const metaHistoryRouter = Router();

/** 503 rather than an empty array — "no data" and "no database" differ. */
function requireDb(res) {
  if (isDbEnabled()) return true;

  res.status(503).json({
    error: 'history_unavailable',
    message:
      'This deployment has no database configured, so meta history is not ' +
      'recorded. Set POSTGRES_URL to enable it.',
  });
  return false;
}

metaHistoryRouter.get('/meta/brawler/:id/history', async (req, res) => {
  if (!requireDb(res)) return;

  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'bad_brawler_id' });
  }

  // Clamped: the window is a URL parameter, and an unbounded one invites a
  // full-table scan from anyone who types a big number.
  const days = Math.min(
    Math.max(Number.parseInt(req.query.days ?? '30', 10) || 30, 1),
    180,
  );

  const mode = typeof req.query.mode === 'string' ? req.query.mode : null;
  const points = await brawlerHistory(id, { days, mode });

  res.json({
    brawlerId: id,
    days,
    mode,
    points: points ?? [],
  });
});

metaHistoryRouter.get('/meta/movers', async (req, res) => {
  if (!requireDb(res)) return;

  const days = Math.min(
    Math.max(Number.parseInt(req.query.days ?? '7', 10) || 7, 1),
    90,
  );
  const limit = Math.min(
    Math.max(Number.parseInt(req.query.limit ?? '10', 10) || 10, 1),
    50,
  );

  res.json({ days, movers: (await topMovers({ days, limit })) ?? [] });
});

/**
 * Standings pooled over a window of raw battles.
 *
 * `/meta/tierlist` is one crawl; this is all of them in the window. The
 * difference matters most per map, where a single crawl often has too few
 * battles to rank anything at all.
 */
metaHistoryRouter.get('/meta/pooled', async (req, res) => {
  if (!requireDb(res)) return;

  const hours = Math.min(
    Math.max(Number.parseInt(req.query.hours ?? '24', 10) || 24, 1),
    24 * 30,
  );

  const mode = typeof req.query.mode === 'string' ? req.query.mode : null;
  const map = typeof req.query.map === 'string' ? req.query.map : null;

  const minSample = Math.min(
    Math.max(Number.parseInt(req.query.minSample ?? '20', 10) || 20, 1),
    500,
  );

  const rows = await pooledStandings({ hours, mode, map, minSample });

  res.json({
    hours,
    mode,
    map,
    minSample,
    // Ranked by Wilson lower bound, same metric the crawler uses, so a pooled
    // list and a live one order brawlers on the same basis.
    brawlers: rank(rows ?? []),
  });
});

/** Maps with enough pooled data to be worth showing stats for. */
metaHistoryRouter.get('/meta/pooled/maps', async (req, res) => {
  if (!requireDb(res)) return;

  const hours = Math.min(
    Math.max(Number.parseInt(req.query.hours ?? '24', 10) || 24, 1),
    24 * 30,
  );

  res.json({ hours, maps: (await pooledMaps({ hours })) ?? [] });
});

/** Server-recorded trophy history for one player. */
metaHistoryRouter.get('/player/:tag/history', async (req, res) => {
  if (!requireDb(res)) return;

  const tag = normaliseTag(req.params.tag);
  if (!tag) return res.status(400).json({ error: 'bad_tag' });

  const days = Math.min(
    Math.max(Number.parseInt(req.query.days ?? '90', 10) || 90, 1),
    365,
  );

  const points = await playerHistory(tag, { days });
  res.json({ tag, days, points: points ?? [] });
});

/**
 * Sorts and tiers pooled rows the way the crawler does.
 *
 * Duplicated deliberately rather than imported: the crawler's version walks its
 * own accumulator shape, and reshaping these rows to fit it would be more code
 * than the twelve lines it saves.
 */
function rank(rows) {
  const ranked = rows
    .map((r) => ({
      ...r,
      score: r.decided > 0 ? wilsonLowerBound(r.wins, r.decided) : 0,
    }))
    .sort((a, b) => b.score - a.score || b.appearances - a.appearances);

  const total = ranked.length;
  ranked.forEach((row, i) => {
    const pct = total <= 1 ? 0 : i / (total - 1);
    row.tier =
      pct <= 0.1 ? 'S' : pct <= 0.3 ? 'A' : pct <= 0.55 ? 'B' : pct <= 0.8 ? 'C' : 'D';
    row.rank = i + 1;
  });

  return ranked;
}
