import { Router } from 'express';

import { config } from '../config.js';
import { cached, cacheGet, cacheSet } from '../cache/store.js';
import { supercell } from '../supercell/client.js';
import { asyncRoute, BadRequestError } from '../middleware/errors.js';

export const rankingsRouter = Router();

/**
 * Validates a region before spending an upstream request.
 *
 * Brawl Stars accepts `global` or a two-letter ISO 3166-1 alpha-2 code. Not
 * every ISO code has a leaderboard — Supercell only ranks regions with enough
 * players — so a valid-looking code can still 404, which the client renders as
 * an empty state rather than an error.
 */
function normaliseRegion(raw) {
  const value = String(raw ?? 'global').trim().toLowerCase();
  if (value === 'global') return 'global';
  if (/^[a-z]{2}$/.test(value)) return value.toUpperCase();

  throw new BadRequestError(
    `Invalid country "${raw}". Use "global" or a two-letter ISO code.`,
  );
}

function clampLimit(raw) {
  const n = Number.parseInt(raw ?? '', 10);
  if (Number.isNaN(n)) return 100;
  // Supercell caps at 200; anything above is silently truncated upstream, so
  // it's clamped here to keep the response honest about what was asked for.
  return Math.min(Math.max(n, 1), 200);
}


/**
 * Adds `rankChange` (positive = climbed) and `isNew` to each row by comparing
 * with a snapshot from about a day earlier. The API has no previous rank, so
 * two snapshots are kept per board: `cur` (taken when the last one turned 20 h
 * old) and `prev` (the one before). Null until a day of history exists.
 */
async function withRankChange(board, items) {
  const key = `rankhist:v1:${board}`;
  const now = Date.now();
  const ranks = Object.fromEntries(items.map((r) => [r.tag, r.rank]));
  let hist = (await cacheGet(key)) ?? null;
  if (!hist?.cur) {
    hist = { cur: { at: now, ranks }, prev: null };
    await cacheSet(key, hist, 7 * 86_400);
  } else if (now - hist.cur.at > 20 * 3_600_000) {
    hist = { prev: hist.cur, cur: { at: now, ranks } };
    await cacheSet(key, hist, 7 * 86_400);
  }
  const prev = hist.prev?.ranks;
  // A 100-row snapshot says nothing about ranks 101-200.
  const depth = prev ? Object.keys(prev).length : 0;
  return items.map((r) => ({
    ...r,
    rankChange: prev && prev[r.tag] != null ? prev[r.tag] - r.rank : null,
    isNew: Boolean(prev) && prev[r.tag] == null && r.rank <= depth,
  }));
}

/** GET /rankings/players?country=global&limit=100 */
rankingsRouter.get(
  '/rankings/players',
  asyncRoute(async (req, res) => {
    const region = normaliseRegion(req.query.country);
    const limit = clampLimit(req.query.limit);

    const { data, cached: hit } = await cached(
      `rankings:players:${region}:${limit}`,
      config.ttl.rankings,
      async () => {
        const raw = await supercell.rankingsPlayers(region, limit);

        return {
          country: region,
          count: (raw.items ?? []).length,
          items: await withRankChange(`players:${region}`, (raw.items ?? []).map((p) => ({
            rank: Number(p.rank ?? 0),
            tag: p.tag ?? '',
            name: p.name ?? '',
            nameColor: p.nameColor ?? '0xffffffff',
            trophies: Number(p.trophies ?? 0),
            iconId: Number(p.icon?.id ?? 0),
            club: p.club?.name ? { name: p.club.name } : null,
          }))),
        };
      },
    );

    res.set('X-Cache', hit ? 'HIT' : 'MISS');
    res.json(data);
  }),
);

/** GET /rankings/clubs?country=global&limit=100 */
rankingsRouter.get(
  '/rankings/clubs',
  asyncRoute(async (req, res) => {
    const region = normaliseRegion(req.query.country);
    const limit = clampLimit(req.query.limit);

    const { data, cached: hit } = await cached(
      `rankings:clubs:${region}:${limit}`,
      config.ttl.rankings,
      async () => {
        const raw = await supercell.rankingsClubs(region, limit);

        return {
          country: region,
          count: (raw.items ?? []).length,
          items: await withRankChange(`clubs:${region}`, (raw.items ?? []).map((c) => ({
            rank: Number(c.rank ?? 0),
            tag: c.tag ?? '',
            name: c.name ?? '',
            trophies: Number(c.trophies ?? 0),
            badgeId: Number(c.badgeId ?? 0),
            memberCount: Number(c.memberCount ?? 0),
          }))),
        };
      },
    );

    res.set('X-Cache', hit ? 'HIT' : 'MISS');
    res.json(data);
  }),
);

/** GET /rankings/brawlers/:id?country=global — top players on one brawler. */
rankingsRouter.get(
  '/rankings/brawlers/:id',
  asyncRoute(async (req, res) => {
    const region = normaliseRegion(req.query.country);
    const limit = clampLimit(req.query.limit);
    const brawlerId = Number.parseInt(req.params.id, 10);

    if (Number.isNaN(brawlerId)) {
      throw new BadRequestError('Brawler id must be numeric.');
    }

    const { data, cached: hit } = await cached(
      `rankings:brawler:${brawlerId}:${region}:${limit}`,
      config.ttl.rankings,
      async () => {
        const raw = await supercell.rankingsBrawler(region, brawlerId, limit);

        return {
          country: region,
          brawlerId,
          count: (raw.items ?? []).length,
          items: await withRankChange(`brawler:${brawlerId}:${region}`, (raw.items ?? []).map((p) => ({
            rank: Number(p.rank ?? 0),
            tag: p.tag ?? '',
            name: p.name ?? '',
            nameColor: p.nameColor ?? '0xffffffff',
            trophies: Number(p.trophies ?? 0),
            iconId: Number(p.icon?.id ?? 0),
            club: p.club?.name ? { name: p.club.name } : null,
          }))),
        };
      },
    );

    res.set('X-Cache', hit ? 'HIT' : 'MISS');
    res.json(data);
  }),
);
