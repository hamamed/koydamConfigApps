/**
 * Which tables the meta analytics read from.
 *
 * There are two records of the same battles. `battle_samples` is the original:
 * one row per brawler per match, no player tag, ~800k rows already collected.
 * `battle_players` is the per-player model from migration 004, which knows who
 * played and carries real team indices and power levels.
 *
 * The new one is strictly better data, and starts empty. A hard switch would
 * blank every meta screen for the days it takes to fill, so the source is
 * resolved at query time: use `battle_players` once it actually has data in the
 * window, otherwise keep serving from `battle_samples`.
 *
 * ## Why fragments rather than a view
 *
 * A database view would be tidier, but the two tables differ in shape, not just
 * in name — mode and map live on `battles` for the new model and on the row
 * itself for the old one. Every query needs both a FROM clause and the right
 * qualified columns, so the fragment carries all three.
 *
 * Every string here is a literal in this file. Nothing from a request ever
 * reaches these, which is what makes interpolating them into SQL safe.
 */

import { query } from './pool.js';
import { config } from '../config.js';
import { log } from '../log.js';

/**
 * SQL fragments per source.
 *
 * `s` is the participant row in both, so a query written against `s.brawler_id`
 * and `MODE`/`MAP` works unchanged on either.
 */
const SOURCES = {
  samples: {
    name: 'battle_samples',
    from: 'battle_samples s',
    mode: 's.mode',
    map: 's.map',
    region: 's.region',
    // Team is nullable on rows crawled before migration 003. In a decided 3v3
    // there are exactly two teams and they always disagree, so the outcome
    // recovers it — without this the pre-003 corpus would drop out of every
    // synergy and counter query.
    team: 'COALESCE(s.team_index, CASE WHEN s.won THEN 1 ELSE 0 END)',
  },
  battles: {
    name: 'battle_players',
    from: 'battle_players s JOIN battles b ON b.battle_key = s.battle_key',
    mode: 'b.mode',
    map: 'b.map',
    region: 's.region',
    // Always written by the new ingest path, so no fallback is needed.
    team: 's.team_index',
  },
};

/**
 * Rows in the new model's recent window before it is considered ready.
 *
 * A handful of rows would technically satisfy "has data" while producing a tier
 * list built on nothing. This is roughly one crawl's worth — enough that the
 * first switched query is answering from a real sample.
 */
const READY_THRESHOLD = 5_000;

let cached = null;
let cachedAt = 0;
let announced = null;

/** How long a resolution is trusted, in ms. */
const TTL = 60_000;

/**
 * Picks the source for this query.
 *
 * Cached for a minute: a crawl runs hourly at most, so the answer cannot change
 * between two requests a second apart, and counting rows on every analytics
 * call would add a query to each one.
 */
export async function resolveSource() {
  const forced = config.analytics.source;

  if (forced === 'samples' || forced === 'battles') {
    return SOURCES[forced];
  }

  const now = Date.now();
  if (cached && now - cachedAt < TTL) return cached;

  // Bounded by the index on battle_time, and stops counting at the threshold —
  // at thirty million rows an unbounded COUNT(*) would scan the table on every
  // cache expiry.
  const res = await query(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT 1 FROM battle_players
        WHERE battle_time > now() - interval '48 hours'
        LIMIT $1
     ) capped`,
    [READY_THRESHOLD],
  );

  const rows = res?.rows?.[0]?.n ?? 0;
  const chosen = rows >= READY_THRESHOLD ? SOURCES.battles : SOURCES.samples;

  // Logged once per change rather than once per resolution. The switchover is a
  // one-time event worth seeing in the journal; repeating it every minute for
  // the rest of the deployment's life is noise.
  if (announced !== chosen.name) {
    log.info('Analytics source resolved', {
      source: chosen.name,
      recentParticipantRows: rows,
      threshold: READY_THRESHOLD,
      reason:
        chosen.name === 'battle_players'
          ? 'per-player model has enough recent data'
          : 'per-player model still filling — serving the legacy table',
    });
    announced = chosen.name;
  }

  cached = chosen;
  cachedAt = now;
  return chosen;
}

/** What the panel reports, without forcing a resolution of its own. */
export function currentSourceName() {
  if (config.analytics.source !== 'auto') {
    return SOURCES[config.analytics.source]?.name ?? 'unknown';
  }
  return cached?.name ?? 'resolving';
}

/** Test seam: drops the memo so the next call re-resolves. */
export function resetSourceCache() {
  cached = null;
  cachedAt = 0;
  announced = null;
}
