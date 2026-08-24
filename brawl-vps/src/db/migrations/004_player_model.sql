-- The per-player model.
--
-- `battle_samples` records that a brawler appeared in a match but never who
-- played it, which makes every per-player question unanswerable server-side.
-- This adds the missing half: battles as first-class rows, and one row per
-- participant carrying the player's tag.
--
-- Deliberately additive. `battle_samples` stays and keeps its own retention, so
-- the tier list, pooled standings and movers keep working off eight hundred
-- thousand existing rows while these tables fill up. Nothing here can be
-- backfilled from it — the player tags were never captured.
--
-- Idempotent throughout.

-- ── players_seen becomes a full profile ─────────────────────────────────────
--
-- Extended rather than replaced by a new `players` table. It already holds the
-- 209 rows the crawler has seen, `staleSearchedPlayers` and the percentile
-- query already read it, and a parallel table would mean two sources of truth
-- for "who do we know about".
ALTER TABLE players_seen ADD COLUMN IF NOT EXISTS name_color       TEXT;
ALTER TABLE players_seen ADD COLUMN IF NOT EXISTS icon_id          INTEGER;
ALTER TABLE players_seen ADD COLUMN IF NOT EXISTS highest_trophies INTEGER;
ALTER TABLE players_seen ADD COLUMN IF NOT EXISTS wins_3v3         INTEGER;
ALTER TABLE players_seen ADD COLUMN IF NOT EXISTS wins_solo        INTEGER;
ALTER TABLE players_seen ADD COLUMN IF NOT EXISTS wins_duo         INTEGER;
ALTER TABLE players_seen ADD COLUMN IF NOT EXISTS exp_level        INTEGER;
ALTER TABLE players_seen ADD COLUMN IF NOT EXISTS exp_points       INTEGER;
ALTER TABLE players_seen ADD COLUMN IF NOT EXISTS club_tag         TEXT;
ALTER TABLE players_seen ADD COLUMN IF NOT EXISTS club_name        TEXT;
ALTER TABLE players_seen ADD COLUMN IF NOT EXISTS brawler_count    INTEGER;

-- When a full profile was last fetched, as opposed to when the player was last
-- *seen* in someone's lobby. The two differ by an API request, and the refresh
-- scheduler needs to tell them apart.
ALTER TABLE players_seen ADD COLUMN IF NOT EXISTS profile_at TIMESTAMPTZ;

-- Serving a searched player from the database means finding them by name too.
CREATE INDEX IF NOT EXISTS players_seen_profile_idx
  ON players_seen (profile_at NULLS FIRST);

CREATE INDEX IF NOT EXISTS players_seen_club_idx
  ON players_seen (club_tag) WHERE club_tag IS NOT NULL;

-- ── Per-player roster ──────────────────────────────────────────────────────
--
-- What each player owns and how far they have taken it. Only written for
-- players whose full profile we fetch, so it stays small.
CREATE TABLE IF NOT EXISTS player_brawlers (
  player_tag       TEXT NOT NULL,
  brawler_id       INTEGER NOT NULL,
  brawler_name     TEXT,
  power            INTEGER,
  rank             INTEGER,
  trophies         INTEGER,
  highest_trophies INTEGER,
  gadgets          INTEGER NOT NULL DEFAULT 0,
  star_powers      INTEGER NOT NULL DEFAULT 0,
  gears            INTEGER NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_tag, brawler_id)
);

CREATE INDEX IF NOT EXISTS player_brawlers_brawler_idx
  ON player_brawlers (brawler_id, trophies DESC);

-- ── Battles ────────────────────────────────────────────────────────────────
--
-- One row per match. The same match appears in every participant's log, so the
-- key has to be derived from the match itself rather than from who reported it.
CREATE TABLE IF NOT EXISTS battles (
  battle_key   TEXT PRIMARY KEY,
  battle_time  TIMESTAMPTZ,
  mode         TEXT NOT NULL,
  map          TEXT,
  battle_type  TEXT,
  duration     INTEGER,
  event_id     INTEGER,
  -- Showdown reports a rank rather than a result, so this is null there and the
  -- per-participant `won` carries the outcome where one exists.
  is_showdown  BOOLEAN NOT NULL DEFAULT false,
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The retention sweep and every windowed query lead with time.
CREATE INDEX IF NOT EXISTS battles_time_idx
  ON battles (battle_time DESC);

CREATE INDEX IF NOT EXISTS battles_mode_map_idx
  ON battles (mode, map, battle_time DESC);

-- ── Battle participants ────────────────────────────────────────────────────
--
-- The table this whole migration exists for. One row per player per match, so
-- "how does this player do with Piper on Hard Rock Mine" stops being a question
-- only the client can answer from its own local cache.
CREATE TABLE IF NOT EXISTS battle_players (
  battle_key       TEXT NOT NULL REFERENCES battles (battle_key) ON DELETE CASCADE,
  player_tag       TEXT NOT NULL,
  player_name      TEXT,
  team_index       SMALLINT,
  brawler_id       INTEGER NOT NULL,
  brawler_name     TEXT,
  brawler_power    INTEGER,
  brawler_trophies INTEGER,
  is_star_player   BOOLEAN NOT NULL DEFAULT false,
  -- Null in showdown, where no per-player outcome is published.
  won              BOOLEAN,
  -- Only ever known for the player whose log we read; null for everyone else in
  -- the lobby. Storing it per-row rather than per-battle keeps that honest.
  trophy_change    INTEGER,
  battle_time      TIMESTAMPTZ,
  PRIMARY KEY (battle_key, player_tag)
);

-- The point of the table: everything one player did, newest first.
CREATE INDEX IF NOT EXISTS battle_players_player_idx
  ON battle_players (player_tag, battle_time DESC);

-- Brawler-centric aggregates, and the self-join for synergy and counters.
CREATE INDEX IF NOT EXISTS battle_players_brawler_idx
  ON battle_players (brawler_id, battle_time DESC);

-- Retention sweeps by time; a plain index keeps that from scanning the table.
CREATE INDEX IF NOT EXISTS battle_players_time_idx
  ON battle_players (battle_time);

-- ── Catalogues ─────────────────────────────────────────────────────────────
--
-- Mirrors of the upstream reference data, stored so analytics can join on ids
-- instead of matching display names between payloads that punctuate them
-- differently.
CREATE TABLE IF NOT EXISTS brawlers_catalog (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  rarity       TEXT,
  class        TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS maps_catalog (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  mode         TEXT,
  environment  TEXT,
  image_url    TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS maps_catalog_mode_idx
  ON maps_catalog (mode);
