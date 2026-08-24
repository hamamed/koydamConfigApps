-- Schema for the crawler's durable record.
--
-- Written to be re-runnable: every statement is IF NOT EXISTS so the migration
-- runner can apply it on every boot without tracking which have run. With one
-- migration file that is simpler and safer than a versions table; if this ever
-- grows to a dozen files, revisit.

-- One row per crawl cycle. The audit trail the panel reads: how long it took,
-- how much it sampled, and whether it finished.
CREATE TABLE IF NOT EXISTS crawl_runs (
  id               BIGSERIAL PRIMARY KEY,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'running',
  players_sampled  INTEGER NOT NULL DEFAULT 0,
  battles_analysed INTEGER NOT NULL DEFAULT 0,
  buckets          INTEGER NOT NULL DEFAULT 0,
  duration_ms      INTEGER,
  error            TEXT
);

CREATE INDEX IF NOT EXISTS crawl_runs_started_idx
  ON crawl_runs (started_at DESC);

-- Raw sampled battles, one row per brawler appearance.
--
-- Deliberately denormalised: the whole point of keeping raw rows is being able
-- to ask questions the aggregate didn't anticipate, and joins against a
-- brawlers table would only save a few bytes per row while making every ad-hoc
-- query harder to write.
CREATE TABLE IF NOT EXISTS battle_samples (
  id             BIGSERIAL PRIMARY KEY,
  run_id         BIGINT REFERENCES crawl_runs (id) ON DELETE CASCADE,
  battle_key     TEXT NOT NULL,
  battle_time    TIMESTAMPTZ,
  mode           TEXT NOT NULL,
  map            TEXT,
  brawler_id     INTEGER NOT NULL,
  brawler_name   TEXT NOT NULL,
  -- NULL for showdown, where the log exposes no per-player outcome.
  won            BOOLEAN,
  trophy_change  INTEGER
);

-- The same match appears in every participant's battle log, so without this a
-- popular brawler in a busy lobby is counted once per player who was in it.
CREATE UNIQUE INDEX IF NOT EXISTS battle_samples_unique_idx
  ON battle_samples (battle_key, brawler_id);

CREATE INDEX IF NOT EXISTS battle_samples_brawler_idx
  ON battle_samples (brawler_id, battle_time DESC);

CREATE INDEX IF NOT EXISTS battle_samples_mode_idx
  ON battle_samples (mode, map);

-- Per-run aggregates: what the tier list showed at that moment.
--
-- Stored rather than recomputed from battle_samples on demand. The aggregate is
-- what was actually served, and recomputing it later against a changed minimum
-- sample size would silently rewrite history.
CREATE TABLE IF NOT EXISTS brawler_stats (
  id           BIGSERIAL PRIMARY KEY,
  run_id       BIGINT NOT NULL REFERENCES crawl_runs (id) ON DELETE CASCADE,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  bucket_kind  TEXT NOT NULL,   -- 'mode' | 'map'
  mode         TEXT NOT NULL,
  map          TEXT,
  brawler_id   INTEGER NOT NULL,
  brawler_name TEXT NOT NULL,
  appearances  INTEGER NOT NULL,
  wins         INTEGER NOT NULL,
  decided      INTEGER NOT NULL,
  win_rate     DOUBLE PRECISION,
  score        DOUBLE PRECISION NOT NULL,
  tier         TEXT NOT NULL,
  rank         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS brawler_stats_trend_idx
  ON brawler_stats (brawler_id, bucket_kind, recorded_at DESC);

CREATE INDEX IF NOT EXISTS brawler_stats_run_idx
  ON brawler_stats (run_id);

-- Players observed on the leaderboards. Not a user table — nobody signs in —
-- just the sampling frame, kept so the panel can show reach over time.
CREATE TABLE IF NOT EXISTS players_seen (
  tag        TEXT PRIMARY KEY,
  name       TEXT,
  trophies   INTEGER,
  region     TEXT,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  times_seen INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS players_seen_last_idx
  ON players_seen (last_seen DESC);
