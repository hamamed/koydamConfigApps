import { Router } from 'express';

import { isDbEnabled } from '../db/pool.js';
import {
  brawlerCounters,
  brawlerSynergy,
  metaHealth,
  regionalStandings,
  rotationCadence,
  rotationHistory,
  trophyBrackets,
  trophyPercentile,
} from '../db/analytics_repo.js';
import { pooledStandings } from '../db/meta_repo.js';
import {
  getProfile,
  getRoster,
  playerBrawlerStats,
  playerCoverage,
  playerMapStats,
} from '../db/player_repo.js';
import { wilsonLowerBound } from '../crawler/meta_crawler.js';
import { normaliseTag } from '../transform/player.js';

/**
 * Analytics derived from the crawled corpus.
 *
 * Every route here is impossible against the upstream API alone: it has no
 * memory, serves one player per request, and never reports which brawlers were
 * in a lobby together. These exist because the crawler wrote it all down.
 */
export const analyticsRouter = Router();

/** 503 rather than an empty array — "no data" and "no database" differ. */
function requireDb(res) {
  if (isDbEnabled()) return true;

  res.status(503).json({
    error: 'analytics_unavailable',
    message:
      'This deployment has no database configured, so analytics are not ' +
      'recorded. Set POSTGRES_URL to enable it.',
  });
  return false;
}

/** Clamps a query param, because the window is caller-supplied. */
function clamp(raw, fallback, min, max) {
  const n = Number.parseInt(raw ?? String(fallback), 10);
  return Math.min(Math.max(Number.isFinite(n) ? n : fallback, min), max);
}

const str = (v) => (typeof v === 'string' && v.length ? v : null);

// ── Synergy and counters ────────────────────────────────────────────────────

analyticsRouter.get('/meta/synergy', async (req, res) => {
  if (!requireDb(res)) return;

  // A week by default. Synergy needs a pair to have played together enough
  // times to mean anything, and a 24-hour window rarely clears the floor.
  const hours = clamp(req.query.hours, 168, 1, 720);
  const minSample = clamp(req.query.minSample, 30, 5, 1000);
  const limit = clamp(req.query.limit, 60, 1, 200);

  const pairs = await brawlerSynergy({
    hours,
    minSample,
    limit,
    mode: str(req.query.mode),
    map: str(req.query.map),
  });

  res.json({
    hours,
    minSample,
    mode: str(req.query.mode),
    map: str(req.query.map),
    // Ranked by the same lower bound the tier list uses, so a 3-0 pair does not
    // outrank a 180-120 one.
    pairs: pairs
      .map((p) => ({ ...p, score: wilsonLowerBound(p.wins, p.games) }))
      .sort((a, b) => b.score - a.score),
  });
});

analyticsRouter.get('/meta/counters/:id', async (req, res) => {
  if (!requireDb(res)) return;

  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'bad_brawler_id' });
  }

  const hours = clamp(req.query.hours, 168, 1, 720);
  const minSample = clamp(req.query.minSample, 25, 5, 1000);

  const rows = await brawlerCounters(id, {
    hours,
    minSample,
    limit: clamp(req.query.limit, 40, 1, 200),
    mode: str(req.query.mode),
    map: str(req.query.map),
  });

  const scored = rows.map((r) => ({
    ...r,
    score: wilsonLowerBound(r.wins, r.games),
  }));

  res.json({
    brawlerId: id,
    hours,
    minSample,
    // Split at the point of the question: who this brawler beats, and who beats
    // it. A single list sorted by win rate makes the reader do that work.
    strongAgainst: scored.filter((r) => (r.winRate ?? 0) > 0.5),
    weakAgainst: scored
      .filter((r) => (r.winRate ?? 0) <= 0.5)
      .sort((a, b) => (a.winRate ?? 0) - (b.winRate ?? 0)),
  });
});

/**
 * Draft assistance: rank picks for a map given who the enemy has already taken.
 *
 * Deliberately server-side. The client would need the whole pairwise matrix to
 * do this itself, which is a large download for a screen most users open twice.
 */
analyticsRouter.get('/meta/draft', async (req, res) => {
  if (!requireDb(res)) return;

  const mode = str(req.query.mode);
  const map = str(req.query.map);
  const hours = clamp(req.query.hours, 168, 1, 720);

  const enemies = String(req.query.enemies ?? '')
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n))
    .slice(0, 3);

  const allies = String(req.query.allies ?? '')
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n))
    .slice(0, 2);

  // Baseline: how each brawler performs on this map at all. Everything else
  // adjusts this, so with no picks entered the draft screen is just the map
  // tier list — which is the correct answer to "what is good here".
  const base = await pooledStandings({
    hours,
    mode,
    map,
    minSample: clamp(req.query.minSample, 20, 5, 1000),
  });

  const [counterRows, synergyRows] = await Promise.all([
    Promise.all(
      enemies.map((e) => brawlerCounters(e, { hours, mode, minSample: 15 })),
    ),
    allies.length
      ? brawlerSynergy({ hours, mode, minSample: 15, limit: 4000 })
      : Promise.resolve([]),
  ]);

  // For each enemy, how they fare against candidate X. Inverted, because the
  // stored direction is "enemy beats X" and the draft wants "X beats enemy".
  const counterAgainst = new Map();
  for (const rows of counterRows) {
    for (const r of rows) {
      const prev = counterAgainst.get(r.id) ?? [];
      prev.push(1 - (r.winRate ?? 0.5));
      counterAgainst.set(r.id, prev);
    }
  }

  const allySet = new Set(allies);
  const synergyWith = new Map();
  for (const p of synergyRows) {
    const aAlly = allySet.has(p.a.id);
    const bAlly = allySet.has(p.b.id);
    if (aAlly === bAlly) continue; // both or neither: not an ally/candidate pair
    const candidate = aAlly ? p.b.id : p.a.id;
    const prev = synergyWith.get(candidate) ?? [];
    prev.push(p.winRate ?? 0.5);
    synergyWith.set(candidate, prev);
  }

  const mean = (xs) =>
    xs && xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

  const picks = base
    .filter((b) => !allySet.has(b.id) && !enemies.includes(b.id))
    .map((b) => {
      const mapScore = b.decided > 0 ? wilsonLowerBound(b.wins, b.decided) : 0;
      const counter = mean(counterAgainst.get(b.id));
      const synergy = mean(synergyWith.get(b.id));

      // Weighted toward the map. A brawler that loses on this map does not
      // become a good pick because it happens to counter one enemy, and
      // weighting them equally is how draft tools end up recommending nonsense.
      let score = mapScore * 0.6;
      let weight = 0.6;
      if (counter !== null) {
        score += counter * 0.25;
        weight += 0.25;
      }
      if (synergy !== null) {
        score += synergy * 0.15;
        weight += 0.15;
      }

      return {
        id: b.id,
        name: b.name,
        score: score / weight,
        mapWinRate: b.winRate,
        appearances: b.appearances,
        // Surfaced so the UI can say *why* — a recommendation without a reason
        // is just an oracle.
        counterScore: counter,
        synergyScore: synergy,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, clamp(req.query.limit, 15, 1, 60));

  res.json({ mode, map, hours, enemies, allies, picks });
});

// ── Meta shape ──────────────────────────────────────────────────────────────

analyticsRouter.get('/meta/health', async (req, res) => {
  if (!requireDb(res)) return;

  const hours = clamp(req.query.hours, 24, 1, 720);
  res.json({ hours, modes: await metaHealth({ hours }) });
});

analyticsRouter.get('/meta/brackets', async (req, res) => {
  if (!requireDb(res)) return;

  const brawlerId = req.query.brawler
    ? Number.parseInt(req.query.brawler, 10)
    : null;

  const hours = clamp(req.query.hours, 168, 1, 720);
  const rows = await trophyBrackets({
    brawlerId: Number.isFinite(brawlerId) ? brawlerId : null,
    mode: str(req.query.mode),
    hours,
    minSample: clamp(req.query.minSample, 20, 5, 1000),
  });

  res.json({ hours, brawlerId, rows });
});

analyticsRouter.get('/meta/regions', async (req, res) => {
  if (!requireDb(res)) return;

  const hours = clamp(req.query.hours, 24, 1, 720);
  const regions = await regionalStandings({
    hours,
    mode: str(req.query.mode),
    minSample: clamp(req.query.minSample, 20, 5, 1000),
  });

  res.json({
    hours,
    // Said plainly rather than left for the client to infer from a single
    // group: one region means the crawler is only watching one ladder.
    note:
      regions.length <= 1
        ? 'Only one region is being crawled. Set CRAWLER_REGIONS to compare.'
        : null,
    regions,
  });
});

// ── Rotation ────────────────────────────────────────────────────────────────

analyticsRouter.get('/events/history', async (req, res) => {
  if (!requireDb(res)) return;

  const days = clamp(req.query.days, 30, 1, 365);
  res.json({
    days,
    entries: await rotationHistory({
      days,
      mode: str(req.query.mode),
      limit: clamp(req.query.limit, 300, 1, 1000),
    }),
  });
});

analyticsRouter.get('/events/cadence', async (req, res) => {
  if (!requireDb(res)) return;

  const days = clamp(req.query.days, 90, 1, 365);
  res.json({
    days,
    maps: await rotationCadence({
      days,
      minAppearances: clamp(req.query.minAppearances, 2, 2, 50),
    }),
  });
});

// ── Player standing ─────────────────────────────────────────────────────────

/**
 * One player's own record, from battles the server stored.
 *
 * Different from what the app computes on device: that covers only the ~25
 * matches the API still remembers, while this accumulates for as long as
 * retention holds. A player crawled for months has a record here that no
 * client could reconstruct.
 */
analyticsRouter.get('/players/:tag/stats', async (req, res) => {
  if (!requireDb(res)) return;

  const tag = normaliseTag(req.params.tag);
  if (!tag) return res.status(400).json({ error: 'bad_tag' });

  const days = clamp(req.query.days, 180, 1, 365);

  const [brawlers, maps, coverage, roster] = await Promise.all([
    playerBrawlerStats(tag, { days }),
    playerMapStats(tag, { days }),
    playerCoverage(tag),
    getRoster(tag),
  ]);

  res.json({
    tag,
    days,
    // Said plainly so the client can distinguish "this player loses a lot" from
    // "we have four of their battles".
    coverage,
    brawlers,
    maps,
    roster,
  });
});

/** The stored profile, without going upstream. */
analyticsRouter.get('/players/:tag/stored', async (req, res) => {
  if (!requireDb(res)) return;

  const tag = normaliseTag(req.params.tag);
  if (!tag) return res.status(400).json({ error: 'bad_tag' });

  const profile = await getProfile(tag);
  if (!profile) return res.status(404).json({ error: 'not_stored' });

  res.json(profile);
});

analyticsRouter.get('/players/percentile/:trophies', async (req, res) => {
  if (!requireDb(res)) return;

  const trophies = Number.parseInt(req.params.trophies, 10);
  if (!Number.isFinite(trophies) || trophies < 0) {
    return res.status(400).json({ error: 'bad_trophies' });
  }

  const result = await trophyPercentile(trophies);
  if (!result) {
    return res.status(404).json({ error: 'no_population_yet' });
  }

  res.json(result);
});
