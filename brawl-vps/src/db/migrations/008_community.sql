-- Community telemetry: what players and clubs changed between two reads.
--
-- The API only ever says what a profile looks like now. Unlocks, power-ups,
-- icon swaps and club moves exist only as the difference between two reads of
-- the same profile, so the last read is kept (compact JSON) and every new read
-- is diffed against it. The diff lands as daily counters, never as raw events:
-- a week of activity is a few thousand rows however many players are sampled.
--
-- Re-run on every boot like every migration here, so: IF NOT EXISTS only, and
-- never a DELETE.

-- Last read of each sampled player, in the shape src/community/diff.js writes.
CREATE TABLE IF NOT EXISTS profile_state (
  tag         TEXT PRIMARY KEY,
  state       JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS profile_state_updated_idx ON profile_state (updated_at);

-- Last read of each sampled club (type, badge, members and their roles).
CREATE TABLE IF NOT EXISTS club_state (
  tag         TEXT PRIMARY KEY,
  state       JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS club_state_updated_idx ON club_state (updated_at);

-- One counter per (UTC day, kind, subject). `subject_id` is the game id when
-- the subject has one (brawler, gear, icon, badge) and 0 otherwise; `subject`
-- is its name, or a "from>to" label for transitions.
CREATE TABLE IF NOT EXISTS community_daily (
  day         DATE    NOT NULL,
  kind        TEXT    NOT NULL,
  subject_id  BIGINT  NOT NULL DEFAULT 0,
  subject     TEXT    NOT NULL DEFAULT '',
  events      BIGINT  NOT NULL,
  PRIMARY KEY (day, kind, subject_id, subject)
);
CREATE INDEX IF NOT EXISTS community_daily_kind_idx ON community_daily (kind, day);

-- The community report counts battles per day and per mode over a week;
-- without this that is a full scan of the table every time it is built.
CREATE INDEX IF NOT EXISTS battles_time_idx ON battles (battle_time);
