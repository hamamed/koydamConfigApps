-- Region on participants, so the analytics can move off battle_samples.
--
-- `battle_samples` gained this in migration 003 and `battle_players` was
-- written without it — which would have left the regional breakdown as the one
-- feature that could never switch to the new model.
--
-- Same caveat as before: this records the ladder the crawl was sampling when it
-- found the battle, not where the players live. A global lobby mixes everyone.
ALTER TABLE battle_players ADD COLUMN IF NOT EXISTS region TEXT;

CREATE INDEX IF NOT EXISTS battle_players_region_idx
  ON battle_players (region, battle_time DESC)
  WHERE region IS NOT NULL;
