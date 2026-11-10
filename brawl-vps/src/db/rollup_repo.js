/**
 * Daily rollups of the pairwise analytics — the write side and its bookkeeping.
 *
 * analytics_repo.js answers synergy, counters and brackets; this file builds
 * the per-day aggregates it answers them from (migration 006). The job that
 * decides *when* to roll a day lives in src/analytics/rollup.js; everything
 * here is SQL and the arithmetic of UTC days.
 *
 * Days are UTC calendar days throughout, passed around as 'YYYY-MM-DD' strings.
 * Strings rather than Date objects because node-postgres turns a DATE column
 * into a Date at *local* midnight, which on a machine that is not on UTC lands
 * on the wrong day. Every query here reads the day back with to_char for the
 * same reason (and to_char rather than ::text, which follows DateStyle).
 */

import { query, withTransaction } from './pool.js';
import { resolveSource } from './source.js';

const DAY_MS = 86_400_000;

// ── Day arithmetic ──────────────────────────────────────────────────────────

/** The UTC calendar day a moment falls on. */
export function utcDay(at = new Date()) {
  return new Date(at).toISOString().slice(0, 10);
}

/** `day` moved by `n` days; negative goes back. */
export function addDays(day, n) {
  return utcDay(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);
}

/**
 * The first day a rollup read covers for an `hours` window.
 *
 * The window's start rounded *down* to UTC midnight, so the days read always
 * contain the whole requested window: between `hours` and `hours + 24` of data,
 * never less. Rounding the other way would make a 24-hour request at 00:30 UTC
 * read thirty minutes of battles.
 */
export function windowStartDay(hours, now = Date.now()) {
  return utcDay(now - hours * 3_600_000);
}

/** Every day from `from` to `to`, inclusive, oldest first. */
export function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// ── Shared SQL ──────────────────────────────────────────────────────────────

/**
 * Trophy bracket for a per-brawler trophy count.
 *
 * Shared by the raw query and the rollup so the two can never bucket the same
 * battle differently. `column` is always a literal from this codebase.
 */
export function bracketCase(column) {
  return `CASE
              WHEN ${column} <  300 THEN '0-299'
              WHEN ${column} <  500 THEN '300-499'
              WHEN ${column} <  700 THEN '500-699'
              WHEN ${column} < 1000 THEN '700-999'
              ELSE '1000+'
            END`;
}

// ── Rolling one day ─────────────────────────────────────────────────────────

/**
 * Rebuilds every rollup for one UTC day, atomically.
 *
 * The day's raw rows are copied once into a temp table, then the three
 * aggregates read from that copy — one pass over the big tables rather than
 * three. The join and win semantics are the ones analytics_repo.js used against
 * the raw tables: decided battles only for pairs and matchups, `team` from the
 * resolved source (with its pre-003 fallback), names by MAX.
 *
 * Delete-then-insert inside one transaction, so a reader sees either the old
 * day or the new one, never half of it; a failure rolls back and leaves the old
 * day standing. Returns a summary, or null when the database is absent or the
 * transaction failed (withTransaction has already logged why).
 */
export async function rollupDay(day) {
  const src = await resolveSource();
  const start = `${day}T00:00:00Z`;
  const end = `${addDays(day, 1)}T00:00:00Z`;
  const began = Date.now();

  const joinedBound = src.joinedTime
    ? `AND ${src.joinedTime} >= $1::timestamptz AND ${src.joinedTime} < $2::timestamptz`
    : '';

  return withTransaction(async (client) => {
    // A runaway rollup must not hold a connection for ever. Ten minutes is far
    // beyond what one day should take; the job retries on its next tick.
    await client.query(`SET LOCAL statement_timeout = '10min'`);

    await client.query(
      `CREATE TEMP TABLE rollup_day (
         battle_key       TEXT,
         brawler_id       INTEGER,
         brawler_name     TEXT,
         won              BOOLEAN,
         team             INTEGER,
         mode             TEXT,
         map              TEXT,
         brawler_trophies INTEGER
       ) ON COMMIT DROP`,
    );

    const raw = await client.query(
      `INSERT INTO rollup_day
       SELECT s.battle_key, s.brawler_id, s.brawler_name, s.won,
              ${src.team},
              COALESCE(${src.mode}, ''),
              COALESCE(${src.map}, ''),
              s.brawler_trophies
         FROM ${src.from}
        WHERE s.battle_time >= $1::timestamptz
          AND s.battle_time <  $2::timestamptz
          ${joinedBound}`,
      [start, end],
    );

    // Temp tables are invisible to autovacuum, so without this the planner
    // guesses their size and can pick a nested loop for a million-row join.
    await client.query('ANALYZE rollup_day');

    await client.query('DELETE FROM pair_stats_daily WHERE day = $1', [day]);
    await client.query('DELETE FROM matchup_stats_daily WHERE day = $1', [day]);
    await client.query('DELETE FROM bracket_stats_daily WHERE day = $1', [day]);
    await client.query('DELETE FROM brawler_stats_daily WHERE day = $1', [day]);

    const pairs = await client.query(
      `INSERT INTO pair_stats_daily
         (day, mode, map, a_id, b_id, a_name, b_name, games, wins)
       SELECT $1::date, a.mode, a.map,
              a.brawler_id, b.brawler_id,
              MAX(a.brawler_name), MAX(b.brawler_name),
              COUNT(*), COUNT(*) FILTER (WHERE a.won)
         FROM rollup_day a
         JOIN rollup_day b
           ON a.battle_key = b.battle_key
          AND a.team = b.team
          AND a.brawler_id < b.brawler_id
        WHERE a.won IS NOT NULL
          AND b.won IS NOT NULL
        GROUP BY a.mode, a.map, a.brawler_id, b.brawler_id`,
      [day],
    );

    const matchups = await client.query(
      `INSERT INTO matchup_stats_daily
         (day, mode, map, brawler_id, opp_id, opp_name, games, wins)
       SELECT $1::date, a.mode, a.map,
              a.brawler_id, b.brawler_id,
              MAX(b.brawler_name),
              COUNT(*), COUNT(*) FILTER (WHERE a.won)
         FROM rollup_day a
         JOIN rollup_day b
           ON a.battle_key = b.battle_key
          AND a.team <> b.team
        WHERE a.won IS NOT NULL
          AND b.won IS NOT NULL
        GROUP BY a.mode, a.map, a.brawler_id, b.brawler_id`,
      [day],
    );

    const brackets = await client.query(
      `INSERT INTO bracket_stats_daily
         (day, mode, brawler_id, bracket, brawler_name,
          appearances, decided, wins)
       SELECT $1::date, mode, brawler_id,
              ${bracketCase('brawler_trophies')} AS bracket,
              MAX(brawler_name),
              COUNT(*),
              COUNT(*) FILTER (WHERE won IS NOT NULL),
              COUNT(*) FILTER (WHERE won)
         FROM rollup_day
        WHERE brawler_trophies IS NOT NULL
        GROUP BY mode, brawler_id, bracket`,
      [day],
    );

    // Every appearance counts, showdown included; only decided games feed the
    // win rate — the same split pooledStandings makes on the raw rows.
    const brawlers = await client.query(
      `INSERT INTO brawler_stats_daily
         (day, mode, map, brawler_id, brawler_name, appearances, decided, wins)
       SELECT $1::date, mode, map, brawler_id,
              MAX(brawler_name),
              COUNT(*),
              COUNT(*) FILTER (WHERE won IS NOT NULL),
              COUNT(*) FILTER (WHERE won)
         FROM rollup_day
        GROUP BY mode, map, brawler_id`,
      [day],
    );

    const summary = {
      day,
      source: src.name,
      durationMs: Date.now() - began,
      rawRows: raw.rowCount ?? 0,
      pairRows: pairs.rowCount ?? 0,
      matchupRows: matchups.rowCount ?? 0,
      bracketRows: brackets.rowCount ?? 0,
      brawlerRows: brawlers.rowCount ?? 0,
    };

    await client.query(
      `INSERT INTO rollup_runs
         (day, source, rolled_at, duration_ms, raw_rows,
          pair_rows, matchup_rows, bracket_rows, brawler_rows)
       VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8)
       ON CONFLICT (day) DO UPDATE SET
         source       = EXCLUDED.source,
         rolled_at    = EXCLUDED.rolled_at,
         duration_ms  = EXCLUDED.duration_ms,
         raw_rows     = EXCLUDED.raw_rows,
         pair_rows    = EXCLUDED.pair_rows,
         matchup_rows = EXCLUDED.matchup_rows,
         bracket_rows = EXCLUDED.bracket_rows,
         brawler_rows = EXCLUDED.brawler_rows`,
      [
        day,
        summary.source,
        summary.durationMs,
        summary.rawRows,
        summary.pairRows,
        summary.matchupRows,
        summary.bracketRows,
        summary.brawlerRows,
      ],
    );

    return summary;
  });
}

// ── Bookkeeping ─────────────────────────────────────────────────────────────

/**
 * Which days in a range have been rolled, and from which source.
 *
 * Returns a Map of day → source name, or null when the query could not run
 * (no database, or the table is missing because migration 006 failed). Null and
 * an empty Map mean different things to the read path: null is "do not trust
 * the rollups at all", empty is "nothing rolled yet".
 */
export async function rolledDays(from, to) {
  const res = await query(
    // A day rolled before migration 007 has no brawler_stats_daily rows
    // (brawler_rows IS NULL): count it as not rolled, so the job rebuilds it.
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, source
       FROM rollup_runs
      WHERE day >= $1::date AND day <= $2::date
        AND brawler_rows IS NOT NULL`,
    [from, to],
  );
  if (!res) return null;

  return new Map(res.rows.map((r) => [r.day, r.source]));
}

/**
 * Whether every day of a read window has been rolled at least once.
 *
 * Any source counts: a day built from battle_samples is still a real answer
 * while the job re-rolls it from battle_players.
 */
export async function windowCoverage(from, to) {
  const rolled = await rolledDays(from, to);
  if (!rolled) return { usable: false, complete: false, missing: null };

  const missing = daysBetween(from, to).filter((d) => !rolled.has(d));
  return { usable: true, complete: missing.length === 0, missing };
}

/**
 * Drops rollups older than `keepDays`.
 *
 * Separate from raw retention on purpose: the rollups are small and the routes
 * only ever ask for up to 30 days, so they keep exactly what can be read.
 */
export async function pruneRollups(keepDays) {
  const cutoff = addDays(utcDay(), -keepDays);
  let removed = 0;

  for (const table of [
    'pair_stats_daily',
    'matchup_stats_daily',
    'bracket_stats_daily',
    'rollup_runs',
  ]) {
    // Table names are literals from the list above, never request input.
    const res = await query(`DELETE FROM ${table} WHERE day < $1::date`, [cutoff]);
    removed += res?.rowCount ?? 0;
  }

  return removed;
}
