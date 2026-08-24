/**
 * The per-player model: profiles, rosters, battles and participants.
 *
 * Split from meta_repo.js, which owns the crawl-aggregate path. The dividing
 * line is what a row is *about*: meta_repo counts brawlers, this counts people.
 *
 * Every write here is idempotent. The same match arrives once per participant
 * whose log we read, so inserts collide constantly by design and `ON CONFLICT`
 * is the normal path rather than the exception.
 */

import { query } from './pool.js';
import { log } from '../log.js';

// ── Profiles ────────────────────────────────────────────────────────────────

/**
 * Writes a full player profile.
 *
 * `source` is only set on insert. Someone found on the leaderboard who later
 * searches for themselves stays 'ranking' — otherwise the panel's breakdown
 * drifts toward whichever path touched them most recently, which describes our
 * traffic rather than the player.
 */
export async function upsertProfile(player, source = 'search') {
  if (!player?.tag) return 0;

  // A refresh passes null: the row already exists, so the INSERT branch never
  // runs and the caller has no business asserting where the player came from.
  // The fallback only matters if the row was deleted underneath us.
  const insertSource = source ?? 'ranking';

  const res = await query(
    `INSERT INTO players_seen (
       tag, name, name_color, icon_id, trophies, highest_trophies,
       wins_3v3, wins_solo, wins_duo, exp_level, exp_points,
       club_tag, club_name, brawler_count, region, source, profile_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
     ON CONFLICT (tag) DO UPDATE SET
       name             = EXCLUDED.name,
       name_color       = EXCLUDED.name_color,
       icon_id          = EXCLUDED.icon_id,
       trophies         = EXCLUDED.trophies,
       highest_trophies = EXCLUDED.highest_trophies,
       wins_3v3         = EXCLUDED.wins_3v3,
       wins_solo        = EXCLUDED.wins_solo,
       wins_duo         = EXCLUDED.wins_duo,
       exp_level        = EXCLUDED.exp_level,
       exp_points       = EXCLUDED.exp_points,
       club_tag         = EXCLUDED.club_tag,
       club_name        = EXCLUDED.club_name,
       brawler_count    = EXCLUDED.brawler_count,
       region           = COALESCE(EXCLUDED.region, players_seen.region),
       last_seen        = now(),
       profile_at       = now(),
       times_seen       = players_seen.times_seen + 1`,
    [
      player.tag,
      player.name ?? null,
      player.nameColor ?? null,
      player.icon?.id ?? null,
      player.trophies ?? null,
      player.highestTrophies ?? null,
      player.wins3v3 ?? player['3vs3Victories'] ?? null,
      player.soloVictories ?? null,
      player.duoVictories ?? null,
      player.expLevel ?? null,
      player.expPoints ?? null,
      player.club?.tag ?? null,
      player.club?.name ?? null,
      Array.isArray(player.brawlers) ? player.brawlers.length : null,
      player.region ?? null,
      insertSource,
    ],
  );

  return res?.rowCount ?? 0;
}

/** Replaces a player's roster with what the profile just reported. */
export async function upsertRoster(tag, brawlers) {
  if (!tag || !Array.isArray(brawlers) || !brawlers.length) return 0;

  const CHUNK = 200;
  let written = 0;

  for (let start = 0; start < brawlers.length; start += CHUNK) {
    const chunk = brawlers.slice(start, start + CHUNK);

    const COLUMNS = 10;
    const values = [];
    const params = [];

    chunk.forEach((b, i) => {
      const o = i * COLUMNS;
      values.push(
        `(${Array.from({ length: COLUMNS }, (_, c) => `$${o + c + 1}`).join(',')})`,
      );
      params.push(
        tag,
        b.id,
        b.name ?? null,
        b.power ?? null,
        b.rank ?? null,
        b.trophies ?? null,
        b.highestTrophies ?? null,
        // Counts, not the arrays. The client derives completion from length and
        // the totals come from static metadata, so the arrays themselves carry
        // nothing worth a row apiece.
        Array.isArray(b.gadgets) ? b.gadgets.length : 0,
        Array.isArray(b.starPowers) ? b.starPowers.length : 0,
        Array.isArray(b.gears) ? b.gears.length : 0,
      );
    });

    const res = await query(
      `INSERT INTO player_brawlers (
         player_tag, brawler_id, brawler_name, power, rank, trophies,
         highest_trophies, gadgets, star_powers, gears
       )
       VALUES ${values.join(',')}
       ON CONFLICT (player_tag, brawler_id) DO UPDATE SET
         brawler_name     = EXCLUDED.brawler_name,
         power            = EXCLUDED.power,
         rank             = EXCLUDED.rank,
         trophies         = EXCLUDED.trophies,
         highest_trophies = EXCLUDED.highest_trophies,
         gadgets          = EXCLUDED.gadgets,
         star_powers      = EXCLUDED.star_powers,
         gears            = EXCLUDED.gears,
         updated_at       = now()`,
      params,
    );

    written += res?.rowCount ?? 0;
  }

  return written;
}

/** A stored profile, or null. Shaped like the API's so routes can serve it. */
export async function getProfile(tag) {
  const res = await query(
    `SELECT tag, name, name_color, icon_id, trophies, highest_trophies,
            wins_3v3, wins_solo, wins_duo, exp_level, exp_points,
            club_tag, club_name, brawler_count, region, source,
            profile_at, last_seen
       FROM players_seen
      WHERE tag = $1`,
    [tag],
  );

  const r = res?.rows?.[0];
  if (!r || !r.profile_at) return null;

  return {
    tag: r.tag,
    name: r.name,
    nameColor: r.name_color,
    icon: { id: r.icon_id },
    trophies: r.trophies,
    highestTrophies: r.highest_trophies,
    '3vs3Victories': r.wins_3v3,
    wins3v3: r.wins_3v3,
    soloVictories: r.wins_solo,
    duoVictories: r.wins_duo,
    expLevel: r.exp_level,
    expPoints: r.exp_points,
    club: r.club_tag ? { tag: r.club_tag, name: r.club_name, badgeId: 0 } : null,
    brawlerCount: r.brawler_count,
    region: r.region,
    profileAt: r.profile_at,
  };
}

/**
 * Players whose full profile is missing or stale, oldest first.
 *
 * Only ranked and searched players. Discovered ones are deliberately excluded:
 * a profile costs an API request on top of their battle log, and spending it on
 * everyone the snowball reaches would halve how fast the frontier widens for
 * data nobody has asked to see.
 *
 * Rotated rather than refreshed wholesale. Trophies move constantly but a
 * roster barely does, so covering the ranked 200 over several cycles costs a
 * fraction of doing all of them every cycle and is no less current in practice.
 */
export async function staleProfiles(limit = 40, { hours = 12 } = {}) {
  const res = await query(
    `SELECT tag FROM players_seen
      WHERE source IN ('ranking', 'search')
        AND (profile_at IS NULL
             OR profile_at < now() - ($1 || ' hours')::interval)
      ORDER BY profile_at NULLS FIRST, last_seen DESC
      LIMIT $2`,
    [String(hours), limit],
  );

  return (res?.rows ?? []).map((r) => r.tag);
}

/** A player's stored roster, strongest first. */
export async function getRoster(tag) {
  const res = await query(
    `SELECT brawler_id, brawler_name, power, rank, trophies,
            highest_trophies, gadgets, star_powers, gears
       FROM player_brawlers
      WHERE player_tag = $1
      ORDER BY trophies DESC NULLS LAST`,
    [tag],
  );

  return (res?.rows ?? []).map((r) => ({
    id: r.brawler_id,
    name: r.brawler_name,
    power: r.power,
    rank: r.rank,
    trophies: r.trophies,
    highestTrophies: r.highest_trophies,
    gadgets: r.gadgets,
    starPowers: r.star_powers,
    gears: r.gears,
  }));
}

// ── Battles ─────────────────────────────────────────────────────────────────

/**
 * Writes battles and their participants.
 *
 * Takes the whole cycle's worth at once. Two statements rather than two per
 * battle: a crawl produces thousands, and a round trip apiece would dominate
 * the cycle time entirely.
 *
 * Battles go first — `battle_players` has a foreign key onto them, and a
 * participant whose battle was dropped by a conflict would be an orphan the
 * insert refuses.
 */
export async function insertBattles(battles, participants) {
  const wroteBattles = await insertBattleRows(battles);
  const wroteParticipants = await insertParticipantRows(participants);
  return { battles: wroteBattles, participants: wroteParticipants };
}

async function insertBattleRows(rows) {
  if (!rows.length) return 0;

  const CHUNK = 400;
  let written = 0;

  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);

    const COLUMNS = 8;
    const values = [];
    const params = [];

    chunk.forEach((b, i) => {
      const o = i * COLUMNS;
      values.push(
        `(${Array.from({ length: COLUMNS }, (_, c) => `$${o + c + 1}`).join(',')})`,
      );
      params.push(
        b.battleKey,
        b.battleTime,
        b.mode,
        b.map,
        b.battleType,
        b.duration,
        b.eventId,
        b.isShowdown,
      );
    });

    // Nothing to update: a battle is immutable once played, and the second
    // report of it carries no more than the first.
    const res = await query(
      `INSERT INTO battles
         (battle_key, battle_time, mode, map, battle_type, duration,
          event_id, is_showdown)
       VALUES ${values.join(',')}
       ON CONFLICT (battle_key) DO NOTHING`,
      params,
    );

    written += res?.rowCount ?? 0;
  }

  return written;
}

async function insertParticipantRows(rows) {
  if (!rows.length) return 0;

  const CHUNK = 300;
  let written = 0;

  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);

    const COLUMNS = 12;
    const values = [];
    const params = [];

    chunk.forEach((p, i) => {
      const o = i * COLUMNS;
      values.push(
        `(${Array.from({ length: COLUMNS }, (_, c) => `$${o + c + 1}`).join(',')})`,
      );
      params.push(
        p.battleKey,
        p.playerTag,
        p.playerName,
        p.teamIndex,
        p.brawlerId,
        p.brawlerName,
        p.brawlerPower,
        p.brawlerTrophies,
        p.isStarPlayer,
        p.won,
        p.battleTime,
        p.region ?? null,
      );
    });

    // Trophy change is the exception to "a battle is immutable": it is only
    // known for the player whose log we read, so a later report of the same
    // match can fill in a null we stored earlier. COALESCE keeps whichever
    // side actually has it.
    const res = await query(
      `INSERT INTO battle_players
         (battle_key, player_tag, player_name, team_index, brawler_id,
          brawler_name, brawler_power, brawler_trophies, is_star_player,
          won, battle_time, region)
       VALUES ${values.join(',')}
       ON CONFLICT (battle_key, player_tag) DO UPDATE SET
         won         = COALESCE(battle_players.won, EXCLUDED.won),
         player_name = COALESCE(EXCLUDED.player_name, battle_players.player_name)`,
      params,
    );

    written += res?.rowCount ?? 0;
  }

  return written;
}

/** Fills in the trophy delta for the one player whose log reported it. */
export async function recordTrophyChanges(deltas) {
  if (!deltas.length) return 0;

  const values = [];
  const params = [];
  deltas.forEach((d, i) => {
    const o = i * 3;
    values.push(`($${o + 1}, $${o + 2}, $${o + 3}::int)`);
    params.push(d.battleKey, d.playerTag, d.trophyChange);
  });

  const res = await query(
    `UPDATE battle_players bp
        SET trophy_change = v.trophy_change
       FROM (VALUES ${values.join(',')})
         AS v (battle_key, player_tag, trophy_change)
      WHERE bp.battle_key = v.battle_key
        AND bp.player_tag = v.player_tag
        AND bp.trophy_change IS NULL`,
    params,
  );

  return res?.rowCount ?? 0;
}

// ── Per-player reads ────────────────────────────────────────────────────────

/**
 * One player's record per brawler, from battles the server stored.
 *
 * Distinct from what the app computes locally: that covers only the last ~25
 * matches the API still remembers, while this accumulates for as long as
 * retention holds — which is the entire reason for keeping battles at all.
 */
export async function playerBrawlerStats(tag, { days = 180 } = {}) {
  const res = await query(
    `SELECT brawler_id,
            MAX(brawler_name)                             AS brawler_name,
            COUNT(*)::int                                 AS battles,
            COUNT(*) FILTER (WHERE won IS NOT NULL)::int  AS decided,
            COUNT(*) FILTER (WHERE won)::int              AS wins,
            COUNT(*) FILTER (WHERE is_star_player)::int   AS star_player,
            SUM(COALESCE(trophy_change, 0))::int          AS trophy_change
       FROM battle_players
      WHERE player_tag = $1
        AND battle_time > now() - ($2 || ' days')::interval
      GROUP BY brawler_id
      ORDER BY battles DESC`,
    [tag, String(days)],
  );

  return (res?.rows ?? []).map((r) => ({
    id: r.brawler_id,
    name: r.brawler_name,
    battles: r.battles,
    decided: r.decided,
    wins: r.wins,
    starPlayer: r.star_player,
    trophyChange: r.trophy_change,
    winRate: r.decided > 0 ? r.wins / r.decided : null,
  }));
}

/** The same, split by map instead of brawler. */
export async function playerMapStats(tag, { days = 180 } = {}) {
  const res = await query(
    `SELECT b.mode, b.map,
            COUNT(*)::int                                    AS battles,
            COUNT(*) FILTER (WHERE bp.won IS NOT NULL)::int  AS decided,
            COUNT(*) FILTER (WHERE bp.won)::int              AS wins
       FROM battle_players bp
       JOIN battles b ON b.battle_key = bp.battle_key
      WHERE bp.player_tag = $1
        AND bp.battle_time > now() - ($2 || ' days')::interval
        AND b.map IS NOT NULL
      GROUP BY b.mode, b.map
     HAVING COUNT(*) >= 3
      ORDER BY battles DESC`,
    [tag, String(days)],
  );

  return (res?.rows ?? []).map((r) => ({
    mode: r.mode,
    map: r.map,
    battles: r.battles,
    decided: r.decided,
    wins: r.wins,
    winRate: r.decided > 0 ? r.wins / r.decided : null,
  }));
}

/** How much history exists for one player. */
export async function playerCoverage(tag) {
  const res = await query(
    `SELECT COUNT(*)::int      AS battles,
            MIN(battle_time)   AS since,
            MAX(battle_time)   AS latest
       FROM battle_players
      WHERE player_tag = $1`,
    [tag],
  );

  const r = res?.rows?.[0];
  if (!r) return { battles: 0, since: null, latest: null };
  return { battles: r.battles, since: r.since, latest: r.latest };
}

// ── Retention ───────────────────────────────────────────────────────────────

/**
 * Drops battles past the retention window.
 *
 * Only `battles` is deleted — `battle_players` has ON DELETE CASCADE, so the
 * participants go with them. Deleting participants directly would leave battles
 * with no players, which reads as data loss rather than expiry.
 *
 * Batched, because a single unbounded DELETE over six months of rows takes a
 * long-lived lock and bloats WAL. The sweep runs often enough that leaving a
 * remainder for the next pass costs nothing.
 */
export async function pruneOldBattles(days = 180, { batch = 20_000 } = {}) {
  let removed = 0;

  for (let pass = 0; pass < 25; pass += 1) {
    const res = await query(
      `DELETE FROM battles
        WHERE battle_key IN (
          SELECT battle_key FROM battles
           WHERE battle_time < now() - ($1 || ' days')::interval
           LIMIT $2
        )`,
      [String(days), batch],
    );

    const n = res?.rowCount ?? 0;
    removed += n;
    if (n < batch) break;
  }

  if (removed > 0) log.info('Pruned old battles', { removed, days });
  return removed;
}

/**
 * Emergency retention, for when the tables outgrow their disk budget.
 *
 * Six months of battles at a fast crawl is tens of gigabytes, and the crawl
 * rate is a config value someone can raise without recomputing what it costs.
 * A Postgres that fills its disk stops accepting writes and is unpleasant to
 * recover, so this trades history for staying alive — loudly, because silently
 * discarding data the operator asked to keep would be worse than the disk.
 */
export async function enforceDiskBudget(budgetBytes, retentionDays) {
  if (!budgetBytes || budgetBytes <= 0) return null;

  const res = await query(
    `SELECT pg_total_relation_size('battles')
          + pg_total_relation_size('battle_players') AS bytes`,
  );

  const bytes = Number(res?.rows?.[0]?.bytes ?? 0);
  if (!bytes || bytes <= budgetBytes) return { bytes, pruned: 0 };

  // Cut the window by the amount we are over, with a floor: below 30 days the
  // pooled queries the app actually makes start coming back empty, and an app
  // showing nothing is not a better outcome than a fuller disk.
  const overBy = bytes / budgetBytes;
  const shrunk = Math.max(30, Math.floor(retentionDays / overBy));

  log.warn('Battle tables over disk budget — shortening retention', {
    gigabytes: +(bytes / 1e9).toFixed(1),
    budgetGigabytes: +(budgetBytes / 1e9).toFixed(1),
    retentionDays,
    effectiveDays: shrunk,
  });

  const pruned = await pruneOldBattles(shrunk);
  return { bytes, pruned, effectiveDays: shrunk };
}
