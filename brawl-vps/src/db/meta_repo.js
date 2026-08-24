import { log } from '../log.js';
import { query, withTransaction } from './pool.js';
import { resolveSource } from './source.js';

/**
 * Every Postgres read and write, in one place.
 *
 * Callers never build SQL. That keeps the parameterisation in a single file —
 * every value below goes through a placeholder, none through interpolation —
 * and means the schema can change without hunting query strings across routes.
 *
 * Every function returns null or an empty array when the database is absent, so
 * the API degrades to its pre-Postgres behaviour instead of failing.
 */

/**
 * Marks runs left 'running' by a process that died as abandoned.
 *
 * A run row is opened before the crawl starts so a crash is distinguishable
 * from a run that never happened. The cost is that a restart mid-crawl strands
 * the row, and the panel would show a crawl running forever. Called on boot,
 * when any row still marked running provably belongs to a dead process — this
 * service runs one crawl at a time.
 */
export async function reapStaleRuns() {
  const res = await query(
    `UPDATE crawl_runs
        SET status = 'abandoned',
            finished_at = now(),
            error = 'process exited before the crawl finished'
      WHERE status = 'running'`,
  );

  const reaped = res?.rowCount ?? 0;
  if (reaped > 0) log.info('Reaped stale crawl runs', { reaped });
  return reaped;
}

/** Opens a run row and returns its id. */
export async function startRun() {
  const res = await query(
    `INSERT INTO crawl_runs (status) VALUES ('running') RETURNING id`,
  );
  return res?.rows?.[0]?.id ?? null;
}

export async function finishRun(runId, summary) {
  if (!runId) return;

  await query(
    `UPDATE crawl_runs
        SET finished_at = now(),
            status = $2,
            players_sampled = $3,
            battles_analysed = $4,
            buckets = $5,
            duration_ms = $6,
            error = $7
      WHERE id = $1`,
    [
      runId,
      summary.error ? 'failed' : 'ok',
      summary.playersSampled ?? 0,
      summary.battlesAnalysed ?? 0,
      summary.buckets ?? 0,
      summary.durationMs ?? null,
      summary.error ?? null,
    ],
  );
}

/**
 * Bulk-inserts sampled battles, ignoring ones already recorded.
 *
 * `ON CONFLICT DO NOTHING` against the (battle_key, brawler_id) unique index is
 * what makes re-crawling safe: consecutive crawls an hour apart overlap heavily
 * — a battle log holds ~25 matches and most players don't play 25 games an hour
 * — so without this the same match would be counted again on every cycle.
 *
 * Chunked because Postgres caps a statement at 65535 bound parameters; at 8
 * columns per row that is ~8000 rows, and 500 keeps a comfortable margin while
 * still being one round trip per chunk rather than per row.
 */
export async function insertBattleSamples(runId, samples) {
  if (!samples.length) return 0;

  const CHUNK = 500;
  let inserted = 0;

  for (let start = 0; start < samples.length; start += CHUNK) {
    const chunk = samples.slice(start, start + CHUNK);

    const COLUMNS = 11;
    const values = [];
    const params = [];
    chunk.forEach((s, i) => {
      const b = i * COLUMNS;
      values.push(
        `(${Array.from({ length: COLUMNS }, (_, c) => `$${b + c + 1}`).join(', ')})`,
      );
      params.push(
        runId,
        s.battleKey,
        s.battleTime,
        s.mode,
        s.map,
        s.brawlerId,
        s.brawlerName,
        s.won,
        s.teamIndex ?? null,
        s.brawlerTrophies ?? null,
        s.region ?? null,
      );
    });

    const res = await query(
      `INSERT INTO battle_samples
         (run_id, battle_key, battle_time, mode, map, brawler_id, brawler_name,
          won, team_index, brawler_trophies, region)
       VALUES ${values.join(', ')}
       ON CONFLICT (battle_key, brawler_id) DO NOTHING`,
      params,
    );

    inserted += res?.rowCount ?? 0;
  }

  return inserted;
}

/** Writes one run's finished tier list. */
export async function insertBrawlerStats(runId, rows) {
  if (!rows.length) return 0;

  const CHUNK = 400;
  let inserted = 0;

  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);

    const COLUMNS = 13;
    const values = [];
    const params = [];

    chunk.forEach((r, i) => {
      const b = i * COLUMNS;
      values.push(
        `(${Array.from({ length: COLUMNS }, (_, c) => `$${b + c + 1}`).join(', ')})`,
      );
      params.push(
        runId,
        r.bucketKind,
        r.mode,
        r.map,
        r.brawlerId,
        r.brawlerName,
        r.appearances,
        r.wins,
        r.decided,
        r.winRate,
        r.score,
        r.tier,
        r.rank,
      );
    });

    const res = await query(
      `INSERT INTO brawler_stats
         (run_id, bucket_kind, mode, map, brawler_id, brawler_name,
          appearances, wins, decided, win_rate, score, tier, rank)
       VALUES ${values.join(', ')}`,
      params,
    );

    inserted += res?.rowCount ?? 0;
  }

  return inserted;
}

/** Records the players a crawl sampled, bumping counts for repeat sightings. */
export async function upsertPlayersSeen(players) {
  if (!players.length) return 0;

  const values = [];
  const params = [];
  players.slice(0, 1000).forEach((p, i) => {
    const b = i * 4;
    values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`);
    params.push(p.tag, p.name ?? null, p.trophies ?? null, p.region ?? null);
  });

  const res = await query(
    `INSERT INTO players_seen (tag, name, trophies, region)
     VALUES ${values.join(', ')}
     ON CONFLICT (tag) DO UPDATE
       SET name = EXCLUDED.name,
           trophies = EXCLUDED.trophies,
           region = EXCLUDED.region,
           last_seen = now(),
           times_seen = players_seen.times_seen + 1`,
    params,
  );

  return res?.rowCount ?? 0;
}

/**
 * Records players met in battle logs.
 *
 * Separate from [upsertPlayersSeen] because the two know different things. A
 * ranking row carries a trophy count and a region; a lobby only gives a tag and
 * a display name, and writing NULLs over a ranked player's trophies would be a
 * downgrade dressed as an update.
 *
 * `source` is never overwritten on conflict: someone found on the leaderboard
 * who later turns up in a lobby is still a ranked player, and flipping them to
 * 'discovered' would make the panel's breakdown drift toward meaninglessness.
 */
export async function upsertDiscoveredPlayers(players) {
  if (!players.length) return 0;

  const CHUNK = 500;
  let written = 0;

  for (let start = 0; start < players.length; start += CHUNK) {
    const chunk = players.slice(start, start + CHUNK);

    const values = [];
    const params = [];
    chunk.forEach((p, i) => {
      const b = i * 2;
      values.push(`($${b + 1}, $${b + 2}, 'discovered')`);
      params.push(p.tag, p.name ?? null);
    });

    const res = await query(
      `INSERT INTO players_seen (tag, name, source)
       VALUES ${values.join(', ')}
       ON CONFLICT (tag) DO UPDATE
         SET name       = COALESCE(EXCLUDED.name, players_seen.name),
             last_seen  = now(),
             times_seen = players_seen.times_seen + 1`,
      params,
    );

    written += res?.rowCount ?? 0;
  }

  return written;
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * One brawler's win rate over time, newest last.
 *
 * Mode buckets only, pooled per run: a chart mixing per-map and overall rows
 * would show the same battles at two granularities and read as noise.
 */
export async function brawlerHistory(brawlerId, { days = 30, mode = null } = {}) {
  const res = await query(
    `SELECT recorded_at,
            SUM(wins)::int              AS wins,
            SUM(decided)::int           AS decided,
            SUM(appearances)::int       AS appearances,
            MIN(rank)                   AS best_rank
       FROM brawler_stats
      WHERE brawler_id = $1
        AND bucket_kind = 'mode'
        AND ($2::text IS NULL OR mode = $2)
        AND recorded_at > now() - ($3 || ' days')::interval
      GROUP BY recorded_at
      ORDER BY recorded_at ASC`,
    [brawlerId, mode, String(days)],
  );

  return (res?.rows ?? []).map((r) => ({
    at: r.recorded_at,
    wins: r.wins,
    decided: r.decided,
    appearances: r.appearances,
    winRate: r.decided > 0 ? r.wins / r.decided : null,
  }));
}

/** Biggest win-rate movers between the newest run and one `days` ago. */
export async function topMovers({ days = 7, limit = 10 } = {}) {
  const res = await query(
    `WITH latest AS (
       SELECT brawler_id, brawler_name,
              SUM(wins)::float / NULLIF(SUM(decided), 0) AS rate,
              SUM(decided)::int AS decided
         FROM brawler_stats
        WHERE bucket_kind = 'mode'
          AND run_id = (SELECT MAX(run_id) FROM brawler_stats)
        GROUP BY brawler_id, brawler_name
     ),
     baseline AS (
       SELECT brawler_id,
              SUM(wins)::float / NULLIF(SUM(decided), 0) AS rate
         FROM brawler_stats
        WHERE bucket_kind = 'mode'
          AND recorded_at BETWEEN now() - ($1 || ' days')::interval
                              AND now() - ($1 || ' days')::interval + interval '6 hours'
        GROUP BY brawler_id
     )
     SELECT l.brawler_id, l.brawler_name, l.rate AS now_rate,
            b.rate AS then_rate, l.decided
       FROM latest l
       JOIN baseline b USING (brawler_id)
      WHERE l.rate IS NOT NULL AND b.rate IS NOT NULL AND l.decided >= 30
      ORDER BY ABS(l.rate - b.rate) DESC
      LIMIT $2`,
    [String(days), limit],
  );

  return (res?.rows ?? []).map((r) => ({
    id: r.brawler_id,
    name: r.brawler_name,
    now: r.now_rate,
    then: r.then_rate,
    change: r.now_rate - r.then_rate,
    decided: r.decided,
  }));
}

/** Everything the panel's header needs, in one round trip. */
export async function panelSummary() {
  const res = await query(
    `SELECT
       (SELECT COUNT(*) FROM crawl_runs)                          AS runs,
       (SELECT COUNT(*) FROM battle_samples)                      AS samples,
       (SELECT COUNT(*) FROM brawler_stats)                       AS stat_rows,
       (SELECT COUNT(*) FROM players_seen)                        AS players,
       (SELECT MAX(finished_at) FROM crawl_runs WHERE status='ok') AS last_ok,
       (SELECT COUNT(*) FROM crawl_runs WHERE status='failed')     AS failures,
       (SELECT COUNT(*) FROM battle_samples
         WHERE battle_time > now() - interval '24 hours')          AS samples_24h`,
  );

  const row = res?.rows?.[0];
  if (!row) return null;

  return {
    runs: Number(row.runs),
    samples: Number(row.samples),
    statRows: Number(row.stat_rows),
    players: Number(row.players),
    lastOk: row.last_ok,
    failures: Number(row.failures),
    samples24h: Number(row.samples_24h),
  };
}

export async function recentRuns(limit = 20) {
  const res = await query(
    `SELECT id, started_at, finished_at, status, players_sampled,
            battles_analysed, buckets, duration_ms, error
       FROM crawl_runs
      ORDER BY started_at DESC
      LIMIT $1`,
    [limit],
  );

  return res?.rows ?? [];
}

/** The newest run's overall standings. */
export async function latestStandings(limit = 40) {
  const res = await query(
    `SELECT brawler_id, brawler_name,
            SUM(appearances)::int AS appearances,
            SUM(wins)::int        AS wins,
            SUM(decided)::int     AS decided,
            SUM(wins)::float / NULLIF(SUM(decided), 0) AS win_rate
       FROM brawler_stats
      WHERE bucket_kind = 'mode'
        AND run_id = (SELECT MAX(run_id) FROM brawler_stats)
      GROUP BY brawler_id, brawler_name
     HAVING SUM(decided) > 0
      ORDER BY win_rate DESC
      LIMIT $1`,
    [limit],
  );

  return res?.rows ?? [];
}

/**
 * Drops sampled battles older than the retention window.
 *
 * Raw rows are the bulk of the database and the least re-read — the aggregates
 * in brawler_stats are what the charts actually use, and those are tiny. Left
 * unbounded a busy crawler adds millions of rows a month for no benefit.
 */
export async function pruneOldSamples(days = 45) {
  const res = await query(
    `DELETE FROM battle_samples
      WHERE battle_time < now() - ($1 || ' days')::interval`,
    [String(days)],
  );

  const removed = res?.rowCount ?? 0;
  if (removed > 0) log.info('Pruned old battle samples', { removed, days });
  return removed;
}

export { withTransaction };

// ── Player universe ─────────────────────────────────────────────────────────

/**
 * Records or refreshes one player, from any source.
 *
 * `source` only moves *up* in usefulness: a tag first seen in a stranger's
 * battle log and later searched by a human becomes 'search' and stays there.
 * Downgrading it on the next crawl would lose the signal that someone cares
 * about this player, which is what the refresh ordering leans on.
 */
export async function upsertPlayer(player, source = 'discovered') {
  if (!player?.tag) return false;

  const res = await query(
    `INSERT INTO players_seen
       (tag, name, trophies, highest_trophies, club_tag, club_name,
        icon_id, exp_level, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (tag) DO UPDATE
       SET name = COALESCE(EXCLUDED.name, players_seen.name),
           trophies = COALESCE(EXCLUDED.trophies, players_seen.trophies),
           highest_trophies =
             COALESCE(EXCLUDED.highest_trophies, players_seen.highest_trophies),
           club_tag = COALESCE(EXCLUDED.club_tag, players_seen.club_tag),
           club_name = COALESCE(EXCLUDED.club_name, players_seen.club_name),
           icon_id = COALESCE(EXCLUDED.icon_id, players_seen.icon_id),
           exp_level = COALESCE(EXCLUDED.exp_level, players_seen.exp_level),
           source = CASE
             WHEN players_seen.source = 'search' THEN 'search'
             WHEN EXCLUDED.source = 'search' THEN 'search'
             WHEN players_seen.source = 'ranking' THEN 'ranking'
             ELSE EXCLUDED.source
           END,
           last_seen = now(),
           times_seen = players_seen.times_seen + 1`,
    [
      player.tag,
      player.name ?? null,
      player.trophies ?? null,
      player.highestTrophies ?? null,
      player.clubTag ?? null,
      player.clubName ?? null,
      player.iconId ?? null,
      player.expLevel ?? null,
      source,
    ],
  );

  return (res?.rowCount ?? 0) > 0;
}

/**
 * Appends a trophy snapshot, at most one per player per hour.
 *
 * The hourly cap is enforced by a unique index rather than a read-then-write,
 * so two concurrent requests for the same profile cannot both decide they are
 * first.
 */
export async function recordPlayerSnapshot(player) {
  if (!player?.tag) return false;

  const res = await query(
    `INSERT INTO player_snapshots
       (tag, hour_bucket, trophies, highest_trophies,
        wins_3v3, wins_solo, wins_duo, brawler_count, exp_level)
     VALUES ($1, date_trunc('hour', now()), $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tag, hour_bucket) DO UPDATE
       SET trophies = EXCLUDED.trophies,
           highest_trophies = EXCLUDED.highest_trophies,
           wins_3v3 = EXCLUDED.wins_3v3,
           wins_solo = EXCLUDED.wins_solo,
           wins_duo = EXCLUDED.wins_duo,
           brawler_count = EXCLUDED.brawler_count,
           exp_level = EXCLUDED.exp_level,
           at = now()`,
    [
      player.tag,
      player.trophies ?? 0,
      player.highestTrophies ?? null,
      player.wins3v3 ?? null,
      player.winsSolo ?? null,
      player.winsDuo ?? null,
      player.brawlerCount ?? null,
      player.expLevel ?? null,
    ],
  );

  return (res?.rowCount ?? 0) > 0;
}

/** One player's recorded trophy history, oldest first. */
export async function playerHistory(tag, { days = 90 } = {}) {
  const res = await query(
    `SELECT at, trophies, highest_trophies, wins_3v3, wins_solo, wins_duo,
            brawler_count, exp_level
       FROM player_snapshots
      WHERE tag = $1
        AND at > now() - ($2 || ' days')::interval
      ORDER BY at ASC`,
    [tag, String(days)],
  );

  return (res?.rows ?? []).map((r) => ({
    at: r.at,
    trophies: r.trophies,
    highestTrophies: r.highest_trophies,
    wins3v3: r.wins_3v3,
    winsSolo: r.wins_solo,
    winsDuo: r.wins_duo,
    brawlerCount: r.brawler_count,
    expLevel: r.exp_level,
  }));
}

// ── Discovery queue ─────────────────────────────────────────────────────────

/**
 * Queues tags met in battle logs.
 *
 * A tag seen repeatedly gets a lower (sooner) priority, because a player who
 * turns up in many logs plays a lot — and a heavy player's log carries more
 * fresh matches per request, which is the whole currency of this crawler.
 */
export async function enqueueDiscovered(tags) {
  if (!tags.length) return 0;

  const unique = [...new Set(tags)].slice(0, 5000);

  const values = [];
  const params = [];
  unique.forEach((tag, i) => {
    values.push(`($${i + 1})`);
    params.push(tag);
  });

  const res = await query(
    `INSERT INTO crawl_queue (tag)
     SELECT v.tag FROM (VALUES ${values.join(', ')}) AS v (tag)
     ON CONFLICT (tag) DO UPDATE
       SET priority = GREATEST(1, crawl_queue.priority - 5)`,
    params,
  );

  return res?.rowCount ?? 0;
}

/**
 * Takes the next batch to crawl and clears it from the queue.
 *
 * Deleted on read rather than marked: a tag that fails is simply not
 * re-queued, and one that succeeds gets rediscovered naturally the next time it
 * appears in someone's log. That keeps the queue a work list rather than a
 * second, slowly-rotting copy of players_seen.
 */
export async function dequeueDiscovered(limit = 100) {
  const res = await query(
    `DELETE FROM crawl_queue
      WHERE tag IN (
        SELECT tag FROM crawl_queue
         ORDER BY priority ASC, discovered_at ASC
         LIMIT $1
      )
      RETURNING tag`,
    [limit],
  );

  return (res?.rows ?? []).map((r) => r.tag);
}

/** Players worth refreshing: searched ones first, least-recently-crawled. */
export async function staleSearchedPlayers(limit = 50) {
  const res = await query(
    `SELECT tag FROM players_seen
      WHERE source = 'search'
        AND (last_crawled_at IS NULL
             OR last_crawled_at < now() - interval '6 hours')
      ORDER BY last_crawled_at NULLS FIRST, last_seen DESC
      LIMIT $1`,
    [limit],
  );

  return (res?.rows ?? []).map((r) => r.tag);
}

export async function markCrawled(tags) {
  if (!tags.length) return 0;
  const res = await query(
    `UPDATE players_seen SET last_crawled_at = now() WHERE tag = ANY($1)`,
    [tags],
  );
  return res?.rowCount ?? 0;
}

// ── Pooled meta ─────────────────────────────────────────────────────────────

/**
 * Brawler standings pooled over a window of raw battles.
 *
 * The Redis tier list is one crawl's worth of data. Per-mode buckets survive
 * that fine, but per-map ones do not: at the moment of writing, 51 of 90 map
 * buckets were empty and the rest often rested on 30–90 battles, which is not
 * enough to rank anything. Pooling a day of raw samples multiplies the sample
 * by the number of crawls in the window.
 *
 * Reads battle_samples rather than brawler_stats on purpose. brawler_stats
 * already had `minSampleSize` applied per crawl, so pooling it would be pooling
 * survivors — a brawler just under the threshold in each of 24 crawls would be
 * missing entirely despite having plenty of battles overall.
 */
export async function pooledStandings({
  hours = 24,
  mode = null,
  map = null,
  minSample = 20,
} = {}) {
  const src = await resolveSource();

  const res = await query(
    `SELECT s.brawler_id,
            MAX(s.brawler_name) AS brawler_name,
            COUNT(*)::int                                    AS appearances,
            COUNT(*) FILTER (WHERE s.won IS NOT NULL)::int   AS decided,
            COUNT(*) FILTER (WHERE s.won)::int               AS wins
       FROM ${src.from}
      WHERE s.battle_time > now() - ($1 || ' hours')::interval
        AND ($2::text IS NULL OR ${src.mode} = $2)
        AND ($3::text IS NULL OR ${src.map} = $3)
      GROUP BY s.brawler_id
     HAVING COUNT(*) >= $4
      ORDER BY appearances DESC`,
    [String(hours), mode, map, minSample],
  );

  return (res?.rows ?? []).map((r) => ({
    id: r.brawler_id,
    name: r.brawler_name,
    appearances: r.appearances,
    decided: r.decided,
    wins: r.wins,
    winRate: r.decided > 0 ? r.wins / r.decided : null,
  }));
}

/** Distinct maps seen in the window, with how much data backs each. */
export async function pooledMaps({ hours = 24, minBattles = 20 } = {}) {
  const src = await resolveSource();

  const res = await query(
    `SELECT ${src.mode} AS mode, ${src.map} AS map,
            COUNT(DISTINCT s.battle_key)::int AS battles
       FROM ${src.from}
      WHERE s.battle_time > now() - ($1 || ' hours')::interval
        AND ${src.map} IS NOT NULL
      GROUP BY ${src.mode}, ${src.map}
     HAVING COUNT(DISTINCT s.battle_key) >= $2
      ORDER BY battles DESC`,
    [String(hours), minBattles],
  );

  return res?.rows ?? [];
}

/**
 * On-disk size of the tables that grow.
 *
 * Surfaced in the panel because retention defaults to a year and the raw table
 * is the one that can run away — seeing it in gigabytes is the signal to turn
 * CRAWLER_DISCOVERY or POSTGRES_RETENTION_DAYS down, and there is no other
 * obvious place that number would show up before the disk filled.
 */
export async function tableSizes() {
  const res = await query(
    `SELECT relname AS table,
            pg_total_relation_size(c.oid)               AS bytes,
            pg_size_pretty(pg_total_relation_size(c.oid)) AS pretty,
            c.reltuples::bigint                          AS approx_rows
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
      ORDER BY pg_total_relation_size(c.oid) DESC`,
  );

  return (res?.rows ?? []).map((r) => ({
    table: r.table,
    bytes: Number(r.bytes),
    pretty: r.pretty,
    approxRows: Number(r.approx_rows),
  }));
}

/** Queue depth and player-universe counts for the panel. */
export async function universeStats() {
  const res = await query(
    `SELECT
       (SELECT COUNT(*) FROM crawl_queue)                                AS queued,
       (SELECT COUNT(*) FROM players_seen WHERE source = 'search')       AS searched,
       (SELECT COUNT(*) FROM players_seen WHERE source = 'discovered')   AS discovered,
       (SELECT COUNT(*) FROM players_seen WHERE source = 'ranking')      AS ranked,
       (SELECT COUNT(*) FROM player_snapshots)                           AS snapshots,
       (SELECT COUNT(DISTINCT tag) FROM player_snapshots)                AS tracked,
       (SELECT COUNT(*) FROM players_seen WHERE profile_at IS NOT NULL)  AS profiled,

       -- Windowed, not total. battle_players is heading for tens of millions of
       -- rows, and a bare COUNT(*) would scan all of them every time the panel
       -- refreshed. The index on battle_time makes this bounded work, and "what
       -- landed today" is the more useful number anyway.
       (SELECT COUNT(*) FROM battles
         WHERE battle_time > now() - interval '24 hours')                AS battles_24h,
       (SELECT COUNT(*) FROM battle_players
         WHERE battle_time > now() - interval '24 hours')                AS participants_24h`,
  );

  const row = res?.rows?.[0];
  if (!row) return null;

  return {
    queued: Number(row.queued),
    searched: Number(row.searched),
    discovered: Number(row.discovered),
    ranked: Number(row.ranked),
    snapshots: Number(row.snapshots),
    tracked: Number(row.tracked),
    profiled: Number(row.profiled),
    battles24h: Number(row.battles_24h),
    participants24h: Number(row.participants_24h),
  };
}
