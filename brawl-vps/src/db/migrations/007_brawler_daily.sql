-- Per-brawler daily totals, the rollup behind pooled standings.
--
-- Draft's baseline and the pooled tier list (/meta/pooled) count each brawler's
-- appearances, decided games and wins over a window. Over a week that is a
-- scan of every raw battle row, which outruns the gateway timeout on the
-- production corpus — the same problem migration 006 solved for pairs and
-- matchups. Same day snapshot, same '' for a missing map.
--
-- `rollup_runs.brawler_rows` is NULL for days rolled before this table
-- existed. The job treats those days as not rolled and rebuilds them, so the
-- table fills itself after deploy without a one-off script. (Migrations re-run
-- on every boot, so this file must never delete anything.)
--
-- Idempotent throughout.

CREATE TABLE IF NOT EXISTS brawler_stats_daily (
  day           DATE    NOT NULL,
  mode          TEXT    NOT NULL,
  map           TEXT    NOT NULL,
  brawler_id    INTEGER NOT NULL,
  brawler_name  TEXT,
  appearances   INTEGER NOT NULL,
  decided       INTEGER NOT NULL,
  wins          INTEGER NOT NULL,
  PRIMARY KEY (day, mode, map, brawler_id)
);

ALTER TABLE rollup_runs ADD COLUMN IF NOT EXISTS brawler_rows INTEGER;
