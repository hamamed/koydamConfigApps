import { query } from './pool.js';

/**
 * Queries behind the brawler, map and mode pages (src/routes/profiles.js).
 * Rollups where they suffice; raw battles only where a rollup lacks the
 * dimension (trophy range without ranked noise, star player, team comps).
 */

const num = (v) => Number(v ?? 0);

/** Trophy range as the pages show it. Ranked battles are excluded upstream. */
const RANGE_SQL = `CASE WHEN bp.brawler_trophies < 500 THEN '0-499'
                        WHEN bp.brawler_trophies < 1000 THEN '500-999'
                        ELSE '1000+' END`;

// ── Every brawler, per trophy range (cached per day by the caller) ───────────

/** Ladder results per (range, brawler) in [start, end), ranked battles excluded. */
export async function rangeTotals(start, end) {
  const res = await query(
    `SELECT ${RANGE_SQL} AS range, bp.brawler_id,
            COUNT(*) FILTER (WHERE bp.won IS NOT NULL)::bigint AS decided,
            COUNT(*) FILTER (WHERE bp.won)::bigint AS wins,
            COUNT(*)::bigint AS picks
       FROM battles b JOIN battle_players bp USING (battle_key)
      WHERE b.battle_time >= $1 AND b.battle_time < $2
        AND b.battle_type IS DISTINCT FROM 'soloRanked'
        AND bp.brawler_trophies IS NOT NULL
      GROUP BY 1, 2`,
    [start, end],
  );
  return (res?.rows ?? []).map((r) => ({
    range: r.range, id: r.brawler_id, decided: num(r.decided), wins: num(r.wins), picks: num(r.picks),
  }));
}

// ── One brawler ──────────────────────────────────────────────────────────────

/** The brawler's results per mode, and every mode's total picks (for use rate). */
export async function brawlerModes(id, fromDay) {
  const res = await query(
    `WITH totals AS (
       SELECT mode, SUM(appearances)::bigint AS picks
         FROM brawler_stats_daily WHERE day >= $2::date GROUP BY mode
     )
     SELECT s.mode, SUM(s.appearances)::bigint AS picks, SUM(s.decided)::bigint AS decided,
            SUM(s.wins)::bigint AS wins, MAX(t.picks)::bigint AS mode_picks
       FROM brawler_stats_daily s JOIN totals t USING (mode)
      WHERE s.brawler_id = $1 AND s.day >= $2::date
      GROUP BY s.mode`,
    [id, fromDay],
  );
  return (res?.rows ?? []).map((r) => ({
    mode: r.mode, picks: num(r.picks), decided: num(r.decided), wins: num(r.wins), modePicks: num(r.mode_picks),
  }));
}

/** The brawler's results per map. */
export async function brawlerMaps(id, fromDay) {
  const res = await query(
    `SELECT mode, map, SUM(appearances)::bigint AS picks, SUM(decided)::bigint AS decided, SUM(wins)::bigint AS wins
       FROM brawler_stats_daily
      WHERE brawler_id = $1 AND day >= $2::date AND map <> ''
      GROUP BY mode, map`,
    [id, fromDay],
  );
  return (res?.rows ?? []).map((r) => ({
    mode: r.mode, map: r.map, picks: num(r.picks), decided: num(r.decided), wins: num(r.wins),
  }));
}

/** The brawler's win rate per UTC day. */
export async function brawlerDaily(id, fromDay) {
  const res = await query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, SUM(appearances)::bigint AS picks,
            SUM(decided)::bigint AS decided, SUM(wins)::bigint AS wins
       FROM brawler_stats_daily WHERE brawler_id = $1 AND day >= $2::date
      GROUP BY day ORDER BY day`,
    [id, fromDay],
  );
  return (res?.rows ?? []).map((r) => ({ day: r.day, picks: num(r.picks), decided: num(r.decided), wins: num(r.wins) }));
}

/** Every brawler's overall results (for the brawler's rank among them). */
export async function allBrawlerTotals(fromDay) {
  const res = await query(
    `SELECT brawler_id, SUM(appearances)::bigint AS picks, SUM(decided)::bigint AS decided, SUM(wins)::bigint AS wins
       FROM brawler_stats_daily WHERE day >= $1::date GROUP BY brawler_id`,
    [fromDay],
  );
  return (res?.rows ?? []).map((r) => ({ id: r.brawler_id, picks: num(r.picks), decided: num(r.decided), wins: num(r.wins) }));
}

/** Per-brawler community counters of the given kinds (b.gear, b.starpower…). */
export async function brawlerCounters(id, fromDay) {
  const res = await query(
    `SELECT kind, subject, SUM(events)::bigint AS n
       FROM community_daily
      WHERE day >= $2::date AND subject_id = $1
        AND (kind LIKE 'b.%' OR kind IN ('unlock.brawler', 'unlock.hypercharge', 'prog.powerup', 'prog.prestige'))
      GROUP BY kind, subject`,
    [id, fromDay],
  );
  return (res?.rows ?? []).map((r) => ({ kind: r.kind, subject: r.subject, n: num(r.n) }));
}

// ── One map ──────────────────────────────────────────────────────────────────

/**
 * Per (range, brawler) results on one map since `since`, ladder only, plus
 * star-player counts (decided games only: showdown has no star player).
 */
export async function mapBrawlers(map, since) {
  const res = await query(
    `SELECT ${RANGE_SQL} AS range, bp.brawler_id, MAX(bp.brawler_name) AS name,
            COUNT(*)::bigint AS picks,
            COUNT(*) FILTER (WHERE bp.won IS NOT NULL)::bigint AS decided,
            COUNT(*) FILTER (WHERE bp.won)::bigint AS wins,
            COUNT(*) FILTER (WHERE bp.is_star_player)::bigint AS stars
       FROM battles b JOIN battle_players bp USING (battle_key)
      WHERE b.map = $1 AND b.battle_time >= $2
        AND b.battle_type IS DISTINCT FROM 'soloRanked'
      GROUP BY 1, 2`,
    [map, since],
  );
  return (res?.rows ?? []).map((r) => ({
    range: r.range, id: r.brawler_id, name: r.name,
    picks: num(r.picks), decided: num(r.decided), wins: num(r.wins), stars: num(r.stars),
  }));
}

/** Ranked (soloRanked) results per brawler on one map. */
export async function mapRanked(map, since) {
  const res = await query(
    `SELECT bp.brawler_id, MAX(bp.brawler_name) AS name,
            COUNT(*) FILTER (WHERE bp.won IS NOT NULL)::bigint AS decided,
            COUNT(*) FILTER (WHERE bp.won)::bigint AS wins
       FROM battles b JOIN battle_players bp USING (battle_key)
      WHERE b.map = $1 AND b.battle_time >= $2 AND b.battle_type = 'soloRanked'
      GROUP BY bp.brawler_id`,
    [map, since],
  );
  return (res?.rows ?? []).map((r) => ({ id: r.brawler_id, name: r.name, decided: num(r.decided), wins: num(r.wins) }));
}

/** Team line-ups on one map: sorted brawler ids per team, with games and wins. */
export async function mapTeams(map, since) {
  const res = await query(
    `WITH teams AS (
       SELECT bp.battle_key, bp.team_index,
              array_agg(bp.brawler_id ORDER BY bp.brawler_id) AS comp,
              bool_or(bp.won) AS won
         FROM battles b JOIN battle_players bp USING (battle_key)
        WHERE b.map = $1 AND b.battle_time >= $2 AND b.is_showdown = false
          AND bp.team_index IS NOT NULL AND bp.won IS NOT NULL
        GROUP BY bp.battle_key, bp.team_index
     )
     SELECT comp, COUNT(*)::int AS games, COUNT(*) FILTER (WHERE won)::int AS wins
       FROM teams WHERE cardinality(comp) BETWEEN 2 AND 5
      GROUP BY comp ORDER BY games DESC LIMIT 2000`,
    [map, since],
  );
  return (res?.rows ?? []).map((r) => ({ comp: r.comp.map(Number), games: r.games, wins: r.wins }));
}

/** Battles on one map since `since`, and its mode. */
export async function mapSummary(map, since) {
  const res = await query(
    `SELECT COUNT(*)::bigint AS battles, MAX(mode) AS mode, MAX(battle_time) AS last_at,
            AVG(duration) FILTER (WHERE duration > 0) AS avg_duration
       FROM battles WHERE map = $1 AND battle_time >= $2`,
    [map, since],
  );
  const r = res?.rows?.[0] ?? {};
  return { battles: num(r.battles), mode: r.mode ?? null, lastAt: r.last_at ?? null, avgDuration: r.avg_duration ? Math.round(Number(r.avg_duration)) : null };
}

/** Every rotation window the crawler has recorded for a map. */
export async function mapRotations(map) {
  const res = await query(
    // One row per window: the slot-id fix wrote a second row for windows that
    // were live at the time.
    `SELECT DISTINCT ON (start_time) mode, slot_id, start_time, end_time FROM map_rotations
      WHERE map = $1 AND start_time IS NOT NULL ORDER BY start_time, slot_id`,
    [map],
  );
  return (res?.rows ?? []).map((r) => ({ mode: r.mode, slot: r.slot_id, start: r.start_time, end: r.end_time }));
}

/** Every brawler's ladder win rate in one mode (for "here vs the mode"). */
export async function modeBrawlers(mode, fromDay) {
  const res = await query(
    `SELECT brawler_id, MAX(brawler_name) AS name, SUM(appearances)::bigint AS picks,
            SUM(decided)::bigint AS decided, SUM(wins)::bigint AS wins
       FROM brawler_stats_daily WHERE mode = $1 AND day >= $2::date
      GROUP BY brawler_id`,
    [mode, fromDay],
  );
  return (res?.rows ?? []).map((r) => ({ id: r.brawler_id, name: r.name, picks: num(r.picks), decided: num(r.decided), wins: num(r.wins) }));
}

// ── One mode ─────────────────────────────────────────────────────────────────

/** Ranked (soloRanked) results per brawler in one mode. */
export async function modeRanked(mode, since) {
  const res = await query(
    `SELECT bp.brawler_id, MAX(bp.brawler_name) AS name, COUNT(*)::bigint AS picks,
            COUNT(*) FILTER (WHERE bp.won IS NOT NULL)::bigint AS decided,
            COUNT(*) FILTER (WHERE bp.won)::bigint AS wins
       FROM battles b JOIN battle_players bp USING (battle_key)
      WHERE b.mode = $1 AND b.battle_time >= $2 AND b.battle_type = 'soloRanked'
      GROUP BY bp.brawler_id`,
    [mode, since],
  );
  return (res?.rows ?? []).map((r) => ({ id: r.brawler_id, name: r.name, picks: num(r.picks), decided: num(r.decided), wins: num(r.wins) }));
}

/** Battles per map in one mode since `since`, with when each was last played. */
export async function modeMaps(mode, since) {
  const res = await query(
    `SELECT map, COUNT(*)::bigint AS battles, MAX(battle_time) AS last_at
       FROM battles WHERE mode = $1 AND battle_time >= $2 AND map IS NOT NULL
      GROUP BY map ORDER BY battles DESC LIMIT 60`,
    [mode, since],
  );
  return (res?.rows ?? []).map((r) => ({ map: r.map, battles: num(r.battles), lastAt: r.last_at }));
}

/** Battles, average length and share of all battles for one mode since `since`. */
export async function modeSummary(mode, since) {
  const res = await query(
    `SELECT COUNT(*) FILTER (WHERE mode = $1)::bigint AS battles,
            COUNT(*)::bigint AS all_battles,
            AVG(duration) FILTER (WHERE mode = $1 AND duration > 0) AS avg_duration,
            COUNT(DISTINCT map) FILTER (WHERE mode = $1)::int AS maps
       FROM battles WHERE battle_time >= $2`,
    [mode, since],
  );
  const r = res?.rows?.[0] ?? {};
  return {
    battles: num(r.battles),
    share: num(r.all_battles) > 0 ? num(r.battles) / num(r.all_battles) : 0,
    avgDuration: r.avg_duration ? Math.round(Number(r.avg_duration)) : null,
    maps: r.maps ?? 0,
  };
}

/** Battles per UTC day for one mode since `since`. */
export async function modeDaily(mode, since) {
  const res = await query(
    `SELECT to_char(date_trunc('day', battle_time AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, COUNT(*)::bigint AS n
       FROM battles WHERE mode = $1 AND battle_time >= $2 GROUP BY 1 ORDER BY 1`,
    [mode, since],
  );
  return (res?.rows ?? []).map((r) => ({ day: r.day, battles: num(r.n) }));
}

/** Battles per map over the last day and week (maps list: busiest, sort). */
export async function mapActivity(dayAgo, weekAgo) {
  const res = await query(
    `SELECT map, MAX(mode) AS mode,
            COUNT(*) FILTER (WHERE battle_time >= $1)::bigint AS day,
            COUNT(*)::bigint AS week, MAX(battle_time) AS last_at
       FROM battles WHERE battle_time >= $2 AND map IS NOT NULL
      GROUP BY map`,
    [dayAgo, weekAgo],
  );
  return (res?.rows ?? []).map((r) => ({ map: r.map, mode: r.mode, day: num(r.day), week: num(r.week), lastAt: r.last_at }));
}

// ── Events overview ──────────────────────────────────────────────────────────

/**
 * Likely next maps for a rotation slot: maps of the same mode whose windows
 * last about as long as the current one (a 2 h featured slot versus a 24 h
 * daily one), least recently played first. Real slot ids win when known.
 */
export async function predictedMaps(mode, slot, currentMap, windowSeconds) {
  const res = await query(
    `SELECT map, MAX(start_time) AS last_at,
            BOOL_OR(slot_id = $2) AS same_slot
       FROM map_rotations
      WHERE mode = $1 AND start_time > now() - interval '120 days'
        AND end_time IS NOT NULL AND map <> $3
        AND EXTRACT(EPOCH FROM (end_time - start_time)) BETWEEN $4 * 0.5 AND $4 * 1.5
      GROUP BY map
      ORDER BY BOOL_OR(slot_id = $2) DESC, MAX(start_time) ASC
      LIMIT 3`,
    [mode, slot, currentMap, windowSeconds],
  );
  return (res?.rows ?? []).map((r) => ({ map: r.map, lastAt: r.last_at }));
}

/** Ladder participants per trophy band since `since` (ranked excluded). */
export async function trophyBands(since) {
  const res = await query(
    `SELECT CASE WHEN bp.brawler_trophies < 100 THEN 0 WHEN bp.brawler_trophies < 300 THEN 1
                 WHEN bp.brawler_trophies < 500 THEN 2 WHEN bp.brawler_trophies < 700 THEN 3
                 WHEN bp.brawler_trophies < 900 THEN 4 WHEN bp.brawler_trophies < 1100 THEN 5
                 WHEN bp.brawler_trophies < 1300 THEN 6 ELSE 7 END AS band,
            COUNT(*)::bigint AS n
       FROM battle_players bp JOIN battles b USING (battle_key)
      WHERE bp.battle_time >= $1 AND b.battle_type IS DISTINCT FROM 'soloRanked' AND bp.brawler_trophies IS NOT NULL
      GROUP BY 1 ORDER BY 1`,
    [since],
  );
  return (res?.rows ?? []).map((r) => ({ band: r.band, n: num(r.n) }));
}

/** Ranked results per (map, tier, brawler) in [start, end); cached per day by the caller. */
export async function rankedMaps(start, end) {
  const res = await query(
    `SELECT b.map, MAX(b.mode) AS mode,
            CASE WHEN bp.brawler_trophies >= 22 THEN 'Pro'
                 ELSE (ARRAY['Bronze','Silver','Gold','Diamond','Mythic','Legendary','Masters'])[CEIL(bp.brawler_trophies / 3.0)::int] END AS tier,
            bp.brawler_id, MAX(bp.brawler_name) AS name,
            COUNT(*)::bigint AS picks,
            COUNT(*) FILTER (WHERE bp.won IS NOT NULL)::bigint AS decided,
            COUNT(*) FILTER (WHERE bp.won)::bigint AS wins,
            COUNT(DISTINCT bp.battle_key)::bigint AS battles
       FROM battles b JOIN battle_players bp USING (battle_key)
      WHERE b.battle_type = 'soloRanked' AND b.battle_time >= $1 AND b.battle_time < $2
        AND bp.brawler_trophies BETWEEN 1 AND 22 AND b.map IS NOT NULL
      GROUP BY b.map, 3, bp.brawler_id`,
    [start, end],
  );
  return (res?.rows ?? []).map((r) => ({
    map: r.map, mode: r.mode, tier: r.tier, id: r.brawler_id, name: r.name,
    picks: num(r.picks), decided: num(r.decided), wins: num(r.wins), battles: num(r.battles),
  }));
}
