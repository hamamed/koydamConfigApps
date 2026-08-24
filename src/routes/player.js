import { Router } from 'express';

import { config } from '../config.js';
import { cached } from '../cache/store.js';
import { supercell, isValidTag } from '../supercell/client.js';
import { transformPlayer, transformBattleLog, normaliseTag } from '../transform/player.js';
import { ingestPlayer, ingestBattleLog } from '../db/ingest.js';
import { asyncRoute, BadRequestError } from '../middleware/errors.js';

export const playerRouter = Router();

/**
 * Rejects malformed tags before spending an upstream request.
 *
 * Supercell would answer 400/404 anyway, but that costs a round trip and counts
 * against the rate limit — and a typo'd tag is the single most common request
 * this API will ever receive.
 */
function requireTag(raw) {
  if (!isValidTag(raw)) {
    throw new BadRequestError(
      'Invalid player tag. Tags use digits 0289 and letters PYLQGRJCUVXWKFMTZ.',
    );
  }
  return normaliseTag(raw);
}

/** GET /player/:tag — full profile, brawlers enriched with metadata. */
playerRouter.get(
  '/player/:tag',
  asyncRoute(async (req, res) => {
    const tag = requireTag(req.params.tag);

    const { data, cached: hit, stale } = await cached(
      `player:${tag}`,
      config.ttl.player,
      async () => transformPlayer(await supercell.player(tag)),
    );

    // Fire and forget — the response never waits on the write. Runs on cache
    // hits too, so the snapshot reflects every time a human looked, not only
    // the times the cache happened to be cold.
    ingestPlayer(data);

    res.set('X-Cache', hit ? (stale ? 'STALE' : 'HIT') : 'MISS');
    res.json(data);
  }),
);

/** GET /player/:tag/battlelog — normalised across 3v3 / showdown / duo shapes. */
playerRouter.get(
  '/player/:tag/battlelog',
  asyncRoute(async (req, res) => {
    const tag = requireTag(req.params.tag);

    const { data, cached: hit, stale } = await cached(
      `battlelog:${tag}`,
      config.ttl.battleLog,
      async () => transformBattleLog(await supercell.battleLog(tag), tag),
    );

    // Stores the battles and queues every participant for the crawler.
    ingestBattleLog(data?.items, tag);

    res.set('X-Cache', hit ? (stale ? 'STALE' : 'HIT') : 'MISS');
    res.json(data);
  }),
);

/** GET /club/:tag — club details plus members. */
playerRouter.get(
  '/club/:tag',
  asyncRoute(async (req, res) => {
    const tag = requireTag(req.params.tag);

    const { data, cached: hit } = await cached(
      `club:${tag}`,
      config.ttl.club,
      async () => {
        // Members live on a separate endpoint; fetched in parallel since neither
        // depends on the other.
        const [club, members] = await Promise.all([
          supercell.club(tag),
          supercell.clubMembers(tag).catch(() => ({ items: [] })),
        ]);

        return {
          tag: club.tag ?? tag,
          name: club.name ?? '',
          description: club.description ?? '',
          type: club.type ?? 'unknown',
          badgeId: Number(club.badgeId ?? 0),
          requiredTrophies: Number(club.requiredTrophies ?? 0),
          trophies: Number(club.trophies ?? 0),
          memberCount: (members.items ?? club.members ?? []).length,
          members: (members.items ?? club.members ?? []).map((m) => ({
            tag: m.tag,
            name: m.name,
            nameColor: m.nameColor ?? '0xffffffff',
            role: m.role ?? 'member',
            trophies: Number(m.trophies ?? 0),
            iconId: Number(m.icon?.id ?? 0),
          })),
        };
      },
    );

    res.set('X-Cache', hit ? 'HIT' : 'MISS');
    res.json(data);
  }),
);
