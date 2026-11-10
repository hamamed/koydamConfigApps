import { query, withTransaction } from './pool.js';
import {
  compactClub,
  compactProfile,
  diffClubs,
  diffProfiles,
  tally,
} from '../community/diff.js';

/**
 * Storage for community telemetry (see src/community/diff.js for the rules).
 *
 * Each sampled profile or club read is diffed against the previous read inside
 * one transaction, so two overlapping crawls can never count the same change
 * twice: the row lock on the state row serialises them.
 */

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

async function bumpCounters(client, rows, day) {
  if (!rows.length) return;
  const values = [];
  const params = [day];
  rows.forEach((r, i) => {
    const o = 1 + i * 4;
    values.push(`($1::date, $${o + 1}, $${o + 2}, $${o + 3}, $${o + 4})`);
    params.push(r.kind, r.id, r.subject, r.events);
  });
  await client.query(
    `INSERT INTO community_daily (day, kind, subject_id, subject, events)
     VALUES ${values.join(',')}
     ON CONFLICT (day, kind, subject_id, subject)
     DO UPDATE SET events = community_daily.events + EXCLUDED.events`,
    params,
  );
}

async function record(table, tag, next, diff) {
  return withTransaction(async (client) => {
    const prev = await client.query(`SELECT state FROM ${table} WHERE tag = $1 FOR UPDATE`, [tag]);
    const events = diff(prev.rows[0]?.state ?? null, next);
    await client.query(
      `INSERT INTO ${table} (tag, state, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (tag) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
      [tag, JSON.stringify(next)],
    );
    await bumpCounters(client, tally(events), utcDay());
    return events.length;
  });
}

/** Diffs a raw `/players/{tag}` read against the last one. Returns events counted. */
export async function recordProfile(raw) {
  if (!raw?.tag) return 0;
  const next = compactProfile(raw);
  return (await record('profile_state', raw.tag, next, (prev, n) => diffProfiles(prev, n, raw))) ?? 0;
}

/** Diffs a raw `/clubs/{tag}` read against the last one. Returns events counted. */
export async function recordClub(raw) {
  if (!raw?.tag) return 0;
  return (await record('club_state', raw.tag, compactClub(raw), diffClubs)) ?? 0;
}

/**
 * Who to read this cycle. Re-reads come first (oldest first, at least `hours`
 * since the last read), since a profile only yields events on its second read;
 * the rest of the budget recruits players the crawler has seen in battle logs,
 * until the cohort reaches `cap`.
 */
export async function communityCohort(limit, { cap = 12_000, hours = 20 } = {}) {
  if (limit <= 0) return [];
  const revisit = await query(
    `SELECT tag FROM profile_state
      WHERE updated_at < now() - ($1 || ' hours')::interval
      ORDER BY updated_at
      LIMIT $2`,
    [String(hours), limit],
  );
  const tags = (revisit?.rows ?? []).map((r) => r.tag);
  const room = limit - tags.length;
  if (room <= 0) return tags;

  const size = await query('SELECT COUNT(*)::int AS n FROM profile_state');
  const open = Math.min(room, Math.max(0, cap - (size?.rows?.[0]?.n ?? 0)));
  if (open <= 0) return tags;

  const fresh = await query(
    `SELECT p.tag FROM players_seen p
      WHERE NOT EXISTS (SELECT 1 FROM profile_state s WHERE s.tag = p.tag)
      ORDER BY p.last_seen DESC NULLS LAST
      LIMIT $1`,
    [open],
  );
  return tags.concat((fresh?.rows ?? []).map((r) => r.tag));
}

/** Clubs of sampled players, re-read oldest first, recruiting until `cap`. */
export async function communityClubs(limit, { cap = 3_000, hours = 20 } = {}) {
  if (limit <= 0) return [];
  const revisit = await query(
    `SELECT tag FROM club_state
      WHERE updated_at < now() - ($1 || ' hours')::interval
      ORDER BY updated_at
      LIMIT $2`,
    [String(hours), limit],
  );
  const tags = (revisit?.rows ?? []).map((r) => r.tag);
  const room = limit - tags.length;
  if (room <= 0) return tags;

  const size = await query('SELECT COUNT(*)::int AS n FROM club_state');
  const open = Math.min(room, Math.max(0, cap - (size?.rows?.[0]?.n ?? 0)));
  if (open <= 0) return tags;

  const fresh = await query(
    `SELECT DISTINCT s.state->>'club' AS tag FROM profile_state s
      WHERE s.state->>'club' IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM club_state c WHERE c.tag = s.state->>'club')
      LIMIT $1`,
    [open],
  );
  return tags.concat((fresh?.rows ?? []).map((r) => r.tag).filter(Boolean));
}

// ── Report queries ────────────────────────────────────────────────────────────

/** How many rows of each kind the report keeps (icons need every row: see route). */
const KEEP = `CASE WHEN kind IN ('icon.gain','icon.drop','club.badge_to','club.badge_from') THEN 2000
                   WHEN kind LIKE 'dist.%' THEN 1000
                   ELSE 25 END`;

/** Activity counters summed over the window, top rows per kind plus each kind's total. */
export async function activityTotals(fromDay) {
  const res = await query(
    `WITH s AS (
       SELECT kind, subject_id, subject, SUM(events)::bigint AS n
         FROM community_daily WHERE day >= $1::date
        GROUP BY kind, subject_id, subject
     ), r AS (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY kind ORDER BY n DESC, subject_id) AS rn,
              SUM(n) OVER (PARTITION BY kind)::bigint AS total,
              COUNT(*) OVER (PARTITION BY kind)::int AS distinct_n
         FROM s
     )
     SELECT kind, subject_id, subject, n, total, distinct_n FROM r WHERE rn <= ${KEEP}
     ORDER BY kind, n DESC`,
    [fromDay],
  );
  return (res?.rows ?? []).map((r) => ({
    kind: r.kind,
    id: Number(r.subject_id),
    subject: r.subject,
    n: Number(r.n),
    total: Number(r.total),
    distinct: r.distinct_n,
  }));
}

/** Per-day totals for every kind in the window. */
export async function activityDaily(fromDay) {
  const res = await query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, kind, SUM(events)::bigint AS n
       FROM community_daily WHERE day >= $1::date
      GROUP BY day, kind ORDER BY day`,
    [fromDay],
  );
  return (res?.rows ?? []).map((r) => ({ day: r.day, kind: r.kind, n: Number(r.n) }));
}

/** Per-brawler appearances and results over the window, from the daily rollups. */
export async function brawlerTotals(fromDay) {
  const res = await query(
    `SELECT brawler_id, MAX(brawler_name) AS name,
            SUM(appearances)::bigint AS picks, SUM(decided)::bigint AS decided,
            SUM(wins)::bigint AS wins
       FROM brawler_stats_daily WHERE day >= $1::date
      GROUP BY brawler_id`,
    [fromDay],
  );
  return (res?.rows ?? []).map((r) => ({
    id: r.brawler_id,
    name: r.name,
    picks: Number(r.picks),
    decided: Number(r.decided),
    wins: Number(r.wins),
  }));
}

/** Battles per mode over the window. */
export async function modeShare(since) {
  const res = await query(
    `SELECT mode, COUNT(*)::bigint AS n FROM battles
      WHERE battle_time >= $1 GROUP BY mode ORDER BY n DESC`,
    [since],
  );
  return (res?.rows ?? []).map((r) => ({ mode: r.mode, battles: Number(r.n) }));
}

/** Battles per UTC day over the window. */
export async function battlesPerDay(since) {
  const res = await query(
    `SELECT to_char(date_trunc('day', battle_time AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
            COUNT(*)::bigint AS n
       FROM battles WHERE battle_time >= $1
      GROUP BY 1 ORDER BY 1`,
    [since],
  );
  return (res?.rows ?? []).map((r) => ({ day: r.day, battles: Number(r.n) }));
}

/**
 * Trophies won per UTC day, from the log owners' own trophy changes (the only
 * rows that carry one), and how many such results there were.
 */
export async function trophiesPerDay(since) {
  const res = await query(
    `SELECT to_char(date_trunc('day', battle_time AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
            COALESCE(SUM(trophy_change) FILTER (WHERE trophy_change > 0), 0)::bigint AS gained,
            COALESCE(SUM(-trophy_change) FILTER (WHERE trophy_change < 0), 0)::bigint AS lost,
            COUNT(*)::bigint AS results
       FROM battle_players
      WHERE battle_time >= $1 AND trophy_change IS NOT NULL
      GROUP BY 1 ORDER BY 1`,
    [since],
  );
  return (res?.rows ?? []).map((r) => ({
    day: r.day,
    gained: Number(r.gained),
    lost: Number(r.lost),
    results: Number(r.results),
  }));
}

/**
 * Ranked (soloRanked) results by tier. In a ranked battle log the brawler's
 * "trophies" field holds the player's ranked division, 1 (Bronze I) to 22
 * (Pro); anything outside that range is not a division and is skipped.
 */
export async function rankedByDivision(since) {
  const res = await query(
    `SELECT bp.brawler_trophies AS division, bp.brawler_id, MAX(bp.brawler_name) AS name,
            COUNT(*)::bigint AS picks,
            COUNT(*) FILTER (WHERE bp.won IS NOT NULL)::bigint AS decided,
            COUNT(*) FILTER (WHERE bp.won)::bigint AS wins,
            COUNT(DISTINCT bp.battle_key)::bigint AS battles
       FROM battle_players bp
       JOIN battles b USING (battle_key)
      WHERE b.battle_type = 'soloRanked'
        AND bp.battle_time >= $1
        AND bp.brawler_trophies BETWEEN 1 AND 22
      GROUP BY bp.brawler_trophies, bp.brawler_id`,
    [since],
  );
  return (res?.rows ?? []).map((r) => ({
    division: r.division,
    id: r.brawler_id,
    name: r.name,
    picks: Number(r.picks),
    decided: Number(r.decided),
    wins: Number(r.wins),
    battles: Number(r.battles),
  }));
}

/** Freshness of each pipeline stage, for the "what we track" strip. */
export async function pipelineStatus() {
  const res = await query(
    `SELECT
       (SELECT MAX(finished_at) FROM crawl_runs WHERE status = 'ok') AS crawl_at,
       (SELECT MAX(rolled_at) FROM rollup_runs) AS rollup_at,
       (SELECT COUNT(*) FROM profile_state)::int AS players,
       (SELECT COUNT(*) FROM club_state)::int AS clubs,
       (SELECT to_char(MIN(day), 'YYYY-MM-DD') FROM community_daily) AS tracking_since`,
  );
  const r = res?.rows?.[0] ?? {};
  return {
    crawlAt: r.crawl_at ?? null,
    rollupAt: r.rollup_at ?? null,
    playersSampled: r.players ?? 0,
    clubsSampled: r.clubs ?? 0,
    trackingSince: r.tracking_since ?? null,
  };
}
