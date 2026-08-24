-- Analytics columns and tables.
--
-- Everything here answers a question the official API cannot: it has no memory,
-- serves one player at a time, and never says which brawlers shared a lobby.
-- Idempotent throughout, so re-running a partial migration is safe.

-- ── battle_samples: three columns the battle log already gave us ────────────
--
-- All three were being parsed and thrown away. Backfill is impossible — rows
-- already stored keep NULL — so every query below has to tolerate NULLs rather
-- than assume coverage.

-- Which team a brawler was on, 0 or 1.
--
-- In 3v3 this is derivable from `won` alone, since there are exactly two teams
-- and they always disagree. Storing it explicitly keeps the synergy/counter
-- joins readable, and it survives duo showdown where `won` is NULL for both
-- members of a pair that nonetheless played together.
ALTER TABLE battle_samples ADD COLUMN IF NOT EXISTS team_index SMALLINT;

-- The brawler's own trophy count at the time of the battle.
--
-- Not the player's total. Per-brawler trophies are the bracket that actually
-- matters for map meta: a 1000-trophy Piper and a 200-trophy Piper are being
-- played by different people in different lobbies.
ALTER TABLE battle_samples ADD COLUMN IF NOT EXISTS brawler_trophies INTEGER;

-- Region of the ranking that seeded the crawl this row came from.
--
-- An approximation, and worth being honest about: a global lobby mixes regions,
-- so this is "the region we were looking at when we found this battle", not
-- "where these players live". With CRAWLER_REGIONS=global it is 'global' for
-- every row and the regional breakdown has nothing to say.
ALTER TABLE battle_samples ADD COLUMN IF NOT EXISTS region TEXT;

-- Synergy and counters group by battle, so the whole lobby has to be found from
-- one row. The unique index on (battle_key, brawler_id) leads with battle_key
-- and already serves that; this one covers the time-windowed scan that picks
-- which battles are recent enough to consider.
--
-- Not partial on team_index: those queries deliberately fall back to `won` for
-- rows crawled before this migration, so restricting the index to new rows
-- would skip exactly the corpus that already exists.
CREATE INDEX IF NOT EXISTS battle_samples_pairing_idx
  ON battle_samples (mode, battle_time DESC);

-- Bracket queries filter to rows that have a trophy count, which is a shrinking
-- minority of the table until the backfill-free columns catch up.
CREATE INDEX IF NOT EXISTS battle_samples_bracket_idx
  ON battle_samples (brawler_id, brawler_trophies)
  WHERE brawler_trophies IS NOT NULL;

-- ── Map rotation history ───────────────────────────────────────────────────
--
-- The events endpoint says what is live now and forgets. Recording each poll
-- turns that into a history, and after a few weeks, a prediction: rotations
-- repeat, so a map's past appearances say when it is due back.
CREATE TABLE IF NOT EXISTS map_rotations (
  id         BIGSERIAL PRIMARY KEY,
  -- One row per (mode, map, slot, start), composed in JS.
  --
  -- A plain column rather than a unique index over COALESCE(...) expressions:
  -- an index expression must be IMMUTABLE, and casting a literal to TIMESTAMPTZ
  -- brushes up against the session TimeZone. Migration 002 already lost a
  -- date_trunc index to that rule; this sidesteps it entirely and gives
  -- ON CONFLICT a trivial target.
  rotation_key TEXT NOT NULL UNIQUE,
  mode       TEXT NOT NULL,
  map        TEXT NOT NULL,
  slot_id    INTEGER,
  start_time TIMESTAMPTZ,
  end_time   TIMESTAMPTZ,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS map_rotations_recent_idx
  ON map_rotations (start_time DESC);

CREATE INDEX IF NOT EXISTS map_rotations_map_idx
  ON map_rotations (map, start_time DESC);
