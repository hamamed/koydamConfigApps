-- Per-club history: every change seen between two reads of a club (members
-- joining and leaving by name, role, type, badge, requirement, description).
-- Written whenever a club is read, by the crawler or when someone opens it.
CREATE TABLE IF NOT EXISTS club_events (
  id       BIGSERIAL PRIMARY KEY,
  tag      TEXT        NOT NULL,
  at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind     TEXT        NOT NULL,
  subject  TEXT        NOT NULL DEFAULT '',
  detail   TEXT        NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS club_events_tag_idx ON club_events (tag, at DESC);

ALTER TABLE club_state ADD COLUMN IF NOT EXISTS first_seen TIMESTAMPTZ NOT NULL DEFAULT now();
