/**
 * Read-only analytics over the crawled corpus.
 *
 * Split from meta_repo.js, which owns the write path — crawl runs, sample
 * inserts, retention. Nothing here writes, and every function answers a
 * question the upstream API cannot: it has no memory, serves one player at a
 * time, and never says which brawlers shared a lobby.
 *
 * All SQL is parameterised. Several of these columns were added in migration
 * 003 with no backfill, so rows crawled before it landed carry NULLs — the
 * queries filter for presence rather than assuming coverage, which means a
 * freshly-migrated server returns empty until the crawler has run a few cycles.
 */

import { query } from './pool.js';
import { resolveSource } from './source.js';

/**
 * Brawler pairs that played on the same team, with how they did together.
 *
 * The join is the whole trick: `battle_samples` stores one row per brawler per
 * battle, so self-joining on `battle_key` reassembles the lobby, and matching
 * `team_index` narrows it to teammates. `a.brawler_id < b.brawler_id` keeps
 * each pair once and drops self-pairs.
 *
 * Only decided battles count. Showdown writes NULL `won` for everyone, so
 * including it would add pairs with no outcome and a meaningless denominator.
 */
export async function brawlerSynergy({
  hours = 168,
  mode = null,
  map = null,
  minSample = 30,
  limit = 60,
} = {}) {
  const src = await resolveSource();

  const res = await query(
    `WITH recent AS (
       SELECT s.battle_key, s.brawler_id, s.brawler_name, s.won,
              ${src.team} AS team
         FROM ${src.from}
        WHERE s.battle_time > now() - ($1 || ' hours')::interval
          AND s.won IS NOT NULL
          AND ($2::text IS NULL OR ${src.mode} = $2)
          AND ($3::text IS NULL OR ${src.map} = $3)
     )
     SELECT a.brawler_id                      AS a_id,
            MAX(a.brawler_name)               AS a_name,
            b.brawler_id                      AS b_id,
            MAX(b.brawler_name)               AS b_name,
            COUNT(*)::int                     AS games,
            COUNT(*) FILTER (WHERE a.won)::int AS wins
       FROM recent a
       JOIN recent b
         ON a.battle_key = b.battle_key
        AND a.team = b.team
        AND a.brawler_id < b.brawler_id
      GROUP BY a.brawler_id, b.brawler_id
     HAVING COUNT(*) >= $4
      ORDER BY (COUNT(*) FILTER (WHERE a.won))::float / COUNT(*) DESC
      LIMIT $5`,
    [String(hours), mode, map, minSample, limit],
  );

  return (res?.rows ?? []).map(toPair);
}

/**
 * How one brawler fares against each brawler it has faced.
 *
 * Same self-join, `team_index` inverted: the other team is the opposition. The
 * win rate is always from the subject's point of view, so 0.68 against Edgar
 * means the subject wins 68% of those matches.
 */
export async function brawlerCounters(brawlerId, {
  hours = 168,
  mode = null,
  map = null,
  minSample = 25,
  limit = 40,
} = {}) {
  const src = await resolveSource();

  const res = await query(
    `WITH recent AS (
       SELECT s.battle_key, s.brawler_id, s.brawler_name, s.won,
              ${src.team} AS team
         FROM ${src.from}
        WHERE s.battle_time > now() - ($1 || ' hours')::interval
          AND s.won IS NOT NULL
          AND ($2::text IS NULL OR ${src.mode} = $2)
          AND ($3::text IS NULL OR ${src.map} = $3)
     )
     SELECT b.brawler_id                      AS b_id,
            MAX(b.brawler_name)               AS b_name,
            COUNT(*)::int                     AS games,
            COUNT(*) FILTER (WHERE a.won)::int AS wins
       FROM recent a
       JOIN recent b
         ON a.battle_key = b.battle_key
        AND a.team <> b.team
      WHERE a.brawler_id = $4
      GROUP BY b.brawler_id
     HAVING COUNT(*) >= $5
      ORDER BY (COUNT(*) FILTER (WHERE a.won))::float / COUNT(*) DESC
      LIMIT $6`,
    [String(hours), mode, map, brawlerId, minSample, limit],
  );

  return (res?.rows ?? []).map((r) => ({
    id: r.b_id,
    name: r.b_name,
    games: r.games,
    wins: r.wins,
    winRate: r.games > 0 ? r.wins / r.games : null,
  }));
}

function toPair(r) {
  return {
    a: { id: r.a_id, name: r.a_name },
    b: { id: r.b_id, name: r.b_name },
    games: r.games,
    wins: r.wins,
    winRate: r.games > 0 ? r.wins / r.games : null,
  };
}

/**
 * Win rate split by the brawler's own trophy count.
 *
 * Per-brawler trophies rather than the player's total: a 1000-trophy Piper and
 * a 200-trophy Piper are being played by different people in different lobbies,
 * and that is exactly the difference this is meant to expose.
 *
 * Brackets are fixed rather than percentile-based so the answer is comparable
 * between brawlers and across weeks.
 */
export async function trophyBrackets({
  brawlerId = null,
  mode = null,
  hours = 168,
  minSample = 20,
} = {}) {
  const src = await resolveSource();

  const res = await query(
    `SELECT s.brawler_id,
            MAX(s.brawler_name) AS brawler_name,
            CASE
              WHEN s.brawler_trophies <  300 THEN '0-299'
              WHEN s.brawler_trophies <  500 THEN '300-499'
              WHEN s.brawler_trophies <  700 THEN '500-699'
              WHEN s.brawler_trophies < 1000 THEN '700-999'
              ELSE '1000+'
            END                                            AS bracket,
            COUNT(*)::int                                  AS appearances,
            COUNT(*) FILTER (WHERE s.won IS NOT NULL)::int AS decided,
            COUNT(*) FILTER (WHERE s.won)::int             AS wins
       FROM ${src.from}
      WHERE s.battle_time > now() - ($1 || ' hours')::interval
        AND s.brawler_trophies IS NOT NULL
        AND ($2::int IS NULL OR s.brawler_id = $2)
        AND ($3::text IS NULL OR ${src.mode} = $3)
      GROUP BY s.brawler_id, bracket
     HAVING COUNT(*) >= $4
      ORDER BY s.brawler_id, bracket`,
    [String(hours), brawlerId, mode, minSample],
  );

  return (res?.rows ?? []).map((r) => ({
    id: r.brawler_id,
    name: r.brawler_name,
    bracket: r.bracket,
    appearances: r.appearances,
    decided: r.decided,
    wins: r.wins,
    winRate: r.decided > 0 ? r.wins / r.decided : null,
  }));
}

/**
 * The same standings, split by the region whose ladder seeded the crawl.
 *
 * Honest caveat baked into the data: `region` records where we were looking,
 * not where the players live, and a global lobby mixes everyone. With
 * CRAWLER_REGIONS=global every row is 'global' and this returns one group.
 */
export async function regionalStandings({
  hours = 24,
  mode = null,
  minSample = 20,
} = {}) {
  const src = await resolveSource();

  const res = await query(
    `SELECT ${src.region} AS region,
            s.brawler_id,
            MAX(s.brawler_name) AS brawler_name,
            COUNT(*)::int                                  AS appearances,
            COUNT(*) FILTER (WHERE s.won IS NOT NULL)::int AS decided,
            COUNT(*) FILTER (WHERE s.won)::int             AS wins
       FROM ${src.from}
      WHERE s.battle_time > now() - ($1 || ' hours')::interval
        AND ${src.region} IS NOT NULL
        AND ($2::text IS NULL OR ${src.mode} = $2)
      GROUP BY ${src.region}, s.brawler_id
     HAVING COUNT(*) >= $3
      ORDER BY region, appearances DESC`,
    [String(hours), mode, minSample],
  );

  const byRegion = new Map();
  for (const r of res?.rows ?? []) {
    const list = byRegion.get(r.region) ?? [];
    list.push({
      id: r.brawler_id,
      name: r.brawler_name,
      appearances: r.appearances,
      decided: r.decided,
      wins: r.wins,
      winRate: r.decided > 0 ? r.wins / r.decided : null,
    });
    byRegion.set(r.region, list);
  }

  return [...byRegion.entries()].map(([region, brawlers]) => ({
    region,
    brawlers,
  }));
}

/**
 * How concentrated the meta is, per mode.
 *
 * Two numbers that move independently: `viable` counts brawlers clearing a
 * usage floor, and `topShare` is the share of all picks taken by the ten most
 * picked. A meta can have many viable brawlers and still be dominated by three,
 * which is why neither number alone is the answer.
 */
export async function metaHealth({ hours = 24, minShare = 0.005 } = {}) {
  const src = await resolveSource();

  const res = await query(
    `WITH picks AS (
       SELECT ${src.mode} AS mode, s.brawler_id, COUNT(*)::int AS appearances
         FROM ${src.from}
        WHERE s.battle_time > now() - ($1 || ' hours')::interval
        GROUP BY ${src.mode}, s.brawler_id
     ),
     totals AS (
       SELECT mode, SUM(appearances)::bigint AS total,
              COUNT(*)::int                  AS distinct_brawlers
         FROM picks GROUP BY mode
     ),
     top10 AS (
       SELECT mode, SUM(appearances)::bigint AS top_appearances
         FROM (
           SELECT mode, appearances,
                  ROW_NUMBER() OVER (PARTITION BY mode ORDER BY appearances DESC) AS rn
             FROM picks
         ) ranked
        WHERE rn <= 10
        GROUP BY mode
     )
     SELECT t.mode,
            t.total,
            t.distinct_brawlers,
            COALESCE(x.top_appearances, 0) AS top_appearances,
            (SELECT COUNT(*)::int FROM picks p
              WHERE p.mode = t.mode
                AND p.appearances::float / NULLIF(t.total, 0) >= $2) AS viable
       FROM totals t
       LEFT JOIN top10 x ON x.mode = t.mode
      WHERE t.total > 0
      ORDER BY t.total DESC`,
    [String(hours), minShare],
  );

  return (res?.rows ?? []).map((r) => ({
    mode: r.mode,
    picks: Number(r.total),
    distinctBrawlers: r.distinct_brawlers,
    viable: r.viable,
    topShare: Number(r.total) > 0
      ? Number(r.top_appearances) / Number(r.total)
      : null,
  }));
}

/**
 * Where a trophy count sits among every player the crawler has seen.
 *
 * The sampling frame is deliberately not a claim about the whole playerbase —
 * it skews high, because the crawl starts at the leaderboard and snowballs from
 * the lobbies those players are in. Reported as "of tracked players" for that
 * reason.
 */
export async function trophyPercentile(trophies) {
  const res = await query(
    `SELECT COUNT(*)::bigint                                    AS total,
            COUNT(*) FILTER (WHERE trophies < $1)::bigint       AS below,
            MAX(trophies)::int                                  AS ceiling
       FROM players_seen
      WHERE trophies IS NOT NULL`,
    [trophies],
  );

  const row = res?.rows?.[0];
  const total = Number(row?.total ?? 0);
  if (!total) return null;

  return {
    trophies,
    trackedPlayers: total,
    percentile: Number(row.below) / total,
    ceiling: row.ceiling,
  };
}

// ── Map rotation history ────────────────────────────────────────────────────

/**
 * Records the maps currently live.
 *
 * Called on every events poll, which happens far more often than the rotation
 * changes — the unique index absorbs the repeats, so this is effectively "note
 * it the first time and touch `last_seen` after that".
 */
export async function recordRotation(events) {
  if (!Array.isArray(events) || !events.length) return 0;

  let written = 0;
  for (const e of events) {
    const mode = e?.event?.mode ?? e?.mode ?? null;
    const map = e?.event?.map ?? e?.map ?? null;
    if (!mode || !map) continue;

    const slotId = e?.event?.id ?? e?.slotId ?? null;
    const startTime = e?.startTime ? parseEventTime(e.startTime) : null;

    const res = await query(
      `INSERT INTO map_rotations
         (rotation_key, mode, map, slot_id, start_time, end_time)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (rotation_key) DO UPDATE SET last_seen = now()`,
      [
        `${mode}|${map}|${slotId ?? ''}|${startTime ?? ''}`,
        mode,
        map,
        slotId,
        startTime,
        e?.endTime ? parseEventTime(e.endTime) : null,
      ],
    );
    written += res?.rowCount ?? 0;
  }

  return written;
}

/** Supercell stamps events the same way it stamps battles. */
function parseEventTime(raw) {
  if (typeof raw !== 'string' || raw.length < 15) return null;
  const iso =
    `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 11)}` +
    `:${raw.slice(11, 13)}:${raw.slice(13)}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Every recorded appearance, newest first. */
export async function rotationHistory({ days = 30, mode = null, limit = 300 } = {}) {
  const res = await query(
    `SELECT mode, map, slot_id, start_time, end_time, first_seen
       FROM map_rotations
      WHERE first_seen > now() - ($1 || ' days')::interval
        AND ($2::text IS NULL OR mode = $2)
      ORDER BY COALESCE(start_time, first_seen) DESC
      LIMIT $3`,
    [String(days), mode, limit],
  );

  return (res?.rows ?? []).map((r) => ({
    mode: r.mode,
    map: r.map,
    slotId: r.slot_id,
    startTime: r.start_time,
    endTime: r.end_time,
    firstSeen: r.first_seen,
  }));
}

/**
 * How often each map comes back, and when it is due.
 *
 * The gap between appearances is the signal. A map seen three times at a steady
 * six-day spacing is predictable; one seen twice is not, which is why
 * `appearances` travels with the estimate instead of being hidden behind it.
 */
export async function rotationCadence({ days = 90, minAppearances = 2 } = {}) {
  const res = await query(
    `WITH appearances AS (
       SELECT mode, map, COALESCE(start_time, first_seen) AS at
         FROM map_rotations
        WHERE COALESCE(start_time, first_seen) > now() - ($1 || ' days')::interval
        GROUP BY mode, map, COALESCE(start_time, first_seen)
     ),
     gaps AS (
       SELECT mode, map, at,
              at - LAG(at) OVER (PARTITION BY mode, map ORDER BY at) AS gap
         FROM appearances
     )
     SELECT mode, map,
            COUNT(*)::int                                       AS appearances,
            MAX(at)                                             AS last_seen,
            AVG(EXTRACT(EPOCH FROM gap))                        AS avg_gap_seconds
       FROM gaps
      GROUP BY mode, map
     HAVING COUNT(*) >= $2
      ORDER BY MAX(at) DESC`,
    [String(days), minAppearances],
  );

  return (res?.rows ?? []).map((r) => {
    const avgGap = r.avg_gap_seconds === null ? null : Number(r.avg_gap_seconds);
    const lastSeen = r.last_seen ? new Date(r.last_seen) : null;

    // Only a projection, and only when there is a gap to project from. Two
    // appearances give one gap, which is a guess; the count rides along so the
    // client can say so.
    const dueAt =
      avgGap && lastSeen
        ? new Date(lastSeen.getTime() + avgGap * 1000).toISOString()
        : null;

    return {
      mode: r.mode,
      map: r.map,
      appearances: r.appearances,
      lastSeen: r.last_seen,
      avgGapDays: avgGap === null ? null : avgGap / 86400,
      dueAt,
    };
  });
}
