import { Router } from 'express';

import { config } from '../config.js';
import { cached } from '../cache/store.js';
import { log } from '../log.js';
import { supercell, isValidTag, UpstreamError } from '../supercell/client.js';
import { normaliseTag } from '../transform/player.js';
import { asyncRoute, BadRequestError } from '../middleware/errors.js';

export const clubActivityRouter = Router();

/**
 * Who in a club has gone quiet.
 *
 * There is no "last online" field anywhere in the API. The only evidence a
 * player is still playing is their battle log, so this fetches one per member
 * and reads the timestamp of their most recent match.
 *
 * That makes it the most expensive endpoint in the service — up to 30 upstream
 * calls for one response — which is why it's cached hard and fetched with a
 * bounded pool rather than 30 parallel requests.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs `worker` over `items` with at most `limit` in flight. */
async function pooled(items, limit, worker) {
  const results = [];
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results.push(await worker(items[index], index));
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * Supercell timestamps are ISO 8601 *basic* (`20260726T141232.000Z`), which
 * `Date.parse` rejects — it wants the separators.
 */
function parseBattleTime(raw) {
  if (typeof raw !== 'string' || raw.length < 15) return null;
  const iso =
    `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 11)}` +
    `:${raw.slice(11, 13)}:${raw.slice(13)}`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** GET /club/:tag/activity — last-seen per member, newest activity first. */
clubActivityRouter.get(
  '/club/:tag/activity',
  asyncRoute(async (req, res) => {
    if (!isValidTag(req.params.tag)) {
      throw new BadRequestError('Invalid club tag.');
    }
    const tag = normaliseTag(req.params.tag);

    const { data, cached: hit } = await cached(
      `club:activity:${tag}`,
      config.ttl.clubActivity,
      async () => {
        const club = await supercell.club(tag);
        const members = club.members ?? [];

        const now = Date.now();
        const rows = await pooled(members, 3, async (m) => {
          const base = {
            tag: m.tag,
            name: m.name,
            role: m.role ?? 'member',
            trophies: Number(m.trophies ?? 0),
            iconId: Number(m.icon?.id ?? 0),
          };

          try {
            const log_ = await supercell.battleLog(m.tag);
            // Spacer keeps a 30-member burst well inside the rate limit.
            await sleep(60);

            const items = log_.items ?? [];
            const lastMs = parseBattleTime(items[0]?.battleTime);

            // Trophy change over the window is a rough measure of whether
            // they're pushing or just logging in.
            const trophyChange = items.reduce(
              (sum, e) => sum + Number(e.battle?.trophyChange ?? 0),
              0,
            );

            return {
              ...base,
              lastSeen: lastMs ? new Date(lastMs).toISOString() : null,
              hoursSinceLastBattle:
                lastMs === null ? null : Math.round((now - lastMs) / 3_600_000),
              recentBattles: items.length,
              recentTrophyChange: trophyChange,
            };
          } catch (err) {
            // A private or deleted account is normal in a 30-person club and
            // must not fail the whole report.
            if (!(err instanceof UpstreamError && err.status === 404)) {
              log.debug('Battle log unavailable for member', {
                tag: m.tag,
                error: err.message,
              });
            }
            return {
              ...base,
              lastSeen: null,
              hoursSinceLastBattle: null,
              recentBattles: 0,
              recentTrophyChange: 0,
              unavailable: true,
            };
          }
        });

        // Quietest last: the point of the screen is spotting who has stopped
        // playing, so active members sort to the top and the tail is the
        // answer.
        rows.sort((a, b) => {
          const ah = a.hoursSinceLastBattle;
          const bh = b.hoursSinceLastBattle;
          if (ah === null && bh === null) return b.trophies - a.trophies;
          if (ah === null) return 1;
          if (bh === null) return -1;
          return ah - bh;
        });

        const known = rows.filter((r) => r.hoursSinceLastBattle !== null);

        return {
          tag: club.tag ?? tag,
          name: club.name ?? '',
          memberCount: rows.length,
          analysedAt: new Date(now).toISOString(),
          summary: {
            active24h: known.filter((r) => r.hoursSinceLastBattle < 24).length,
            active7d: known.filter((r) => r.hoursSinceLastBattle < 168).length,
            inactive7d: known.filter((r) => r.hoursSinceLastBattle >= 168).length,
            // Battle logs expire after a few days of inactivity, so an empty
            // log means "gone for a while", not "never played".
            noRecentData: rows.length - known.length,
          },
          members: rows,
        };
      },
    );

    res.set('X-Cache', hit ? 'HIT' : 'MISS');
    res.json(data);
  }),
);
