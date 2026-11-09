-- Daily rollups for the week-long analytics.
--
-- Synergy, counters and trophy brackets self-join raw participant rows over the
-- whole window. At 24 hours that answers in a few seconds; at a week it outruns
-- the gateway's 20-second limit, and the raw tables grow ~11GB a month, so it
-- only gets worse. These tables hold the same aggregates one UTC day at a time,
-- written by src/analytics/rollup.js, so a week becomes a SUM over eight small
-- slices instead of a self-join over millions of rows.
--
-- Every row is reproducible from the raw tables while they are retained: a day
-- is re-rolled by deleting it and inserting it again, in one transaction. That
-- is why there is no "updated_at" here — rollup_runs records when a day was
-- last rebuilt and from which source.
--
-- Mode and map stay as dimensions so the optional filters keep working. Map is
-- NOT NULL with '' standing in for "the battle had no map", because a primary
-- key cannot contain NULL. The routes turn an empty query string into "no
-- filter", so '' can never be asked for and never matches a real filter — the
-- same result the raw query gives for a NULL map.
--
-- Idempotent throughout.

-- ── Same-team pairs ─────────────────────────────────────────────────────────
--
-- Exactly what brawlerSynergy computes, for one day: decided battles only,
-- a_id < b_id so each pair appears once, wins counted from a's side (which is
-- also b's side — they were teammates).
CREATE TABLE IF NOT EXISTS pair_stats_daily (
  day     DATE    NOT NULL,
  mode    TEXT    NOT NULL,
  map     TEXT    NOT NULL DEFAULT '',
  a_id    INTEGER NOT NULL,
  b_id    INTEGER NOT NULL,
  a_name  TEXT,
  b_name  TEXT,
  games   INTEGER NOT NULL,
  wins    INTEGER NOT NULL,
  PRIMARY KEY (day, mode, map, a_id, b_id)
);

-- ── Opposing-team matchups ──────────────────────────────────────────────────
--
-- What brawlerCounters computes, but for every brawler at once. Wins are from
-- brawler_id's point of view. Both directions are stored (X vs Y and Y vs X)
-- because a counters request filters on one side, and halving the table would
-- turn that into an OR across two columns.
CREATE TABLE IF NOT EXISTS matchup_stats_daily (
  day         DATE    NOT NULL,
  mode        TEXT    NOT NULL,
  map         TEXT    NOT NULL DEFAULT '',
  brawler_id  INTEGER NOT NULL,
  opp_id      INTEGER NOT NULL,
  opp_name    TEXT,
  games       INTEGER NOT NULL,
  wins        INTEGER NOT NULL,
  PRIMARY KEY (day, mode, map, brawler_id, opp_id)
);

-- The primary key leads with day, which suits the synergy-style "everything in
-- the window" scan. A counters request asks for one brawler, so it gets its own
-- path in.
CREATE INDEX IF NOT EXISTS matchup_stats_daily_brawler_idx
  ON matchup_stats_daily (brawler_id, day);

-- ── Trophy brackets ─────────────────────────────────────────────────────────
--
-- What trophyBrackets computes, per day. No map dimension: the endpoint has no
-- map filter. Appearances include showdown (won IS NULL), exactly as the raw
-- query does, which is why decided travels separately.
CREATE TABLE IF NOT EXISTS bracket_stats_daily (
  day           DATE    NOT NULL,
  mode          TEXT    NOT NULL,
  brawler_id    INTEGER NOT NULL,
  bracket       TEXT    NOT NULL,
  brawler_name  TEXT,
  appearances   INTEGER NOT NULL,
  decided       INTEGER NOT NULL,
  wins          INTEGER NOT NULL,
  PRIMARY KEY (day, mode, brawler_id, bracket)
);

-- ── Bookkeeping ─────────────────────────────────────────────────────────────
--
-- One row per rolled day. Its presence is what the read path calls "covered":
-- a day with no row here has never been rolled, and a week with a gap is served
-- partially (or from the raw tables, for windows of a day or less). `source`
-- records which raw table the day was built from, so a later switch from
-- battle_samples to battle_players can re-roll the days built from the old one.
CREATE TABLE IF NOT EXISTS rollup_runs (
  day           DATE PRIMARY KEY,
  source        TEXT        NOT NULL,
  rolled_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms   INTEGER,
  raw_rows      INTEGER,
  pair_rows     INTEGER,
  matchup_rows  INTEGER,
  bracket_rows  INTEGER
);
