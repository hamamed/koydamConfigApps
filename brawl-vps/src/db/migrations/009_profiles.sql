-- Map and mode pages read one map's (or mode's) battles over a month; without
-- these that is a scan of the whole table per request.
CREATE INDEX IF NOT EXISTS battles_map_time_idx ON battles (map, battle_time);
CREATE INDEX IF NOT EXISTS battles_mode_time_idx ON battles (mode, battle_time);
CREATE INDEX IF NOT EXISTS map_rotations_map_idx ON map_rotations (map, start_time);
