-- Three things the panel can say to an app's users without a release:
-- a banner, when to ask for a review, and what changed in this version.

-- ── Announcements ───────────────────────────────────────────────────────────
--
-- One dismissible message in the app. The reason this is worth a table rather
-- than a feature flag: a flag turns a screen on and off, while this carries
-- text, a link, a window of time and a range of versions it applies to.
CREATE TABLE IF NOT EXISTS announcements (
  id          BIGSERIAL PRIMARY KEY,
  app_slug    TEXT NOT NULL REFERENCES apps (slug) ON DELETE CASCADE,
  -- NULL means both. Most announcements are not platform-specific, and forcing
  -- two rows for one message invites the two drifting apart.
  platform    TEXT CHECK (platform IN ('ios', 'android')),

  -- How the client should style it. Free text rather than an enum so a new
  -- treatment does not need a migration before it can be used.
  kind        TEXT NOT NULL DEFAULT 'info',
  title       TEXT NOT NULL,
  body        TEXT,

  link_url    TEXT,
  link_label  TEXT,

  -- Inclusive, either side optional. Written as strings because that is what
  -- a store build reports; the comparison happens in code, since "1.10.0"
  -- sorts before "1.9.0" as text and would target the wrong people.
  min_version TEXT,
  max_version TEXT,

  -- A window, so "during the weekend event" does not need someone awake at
  -- either end of it.
  starts_at   TIMESTAMPTZ,
  ends_at     TIMESTAMPTZ,

  -- False for something that must stay put, like a degraded-service notice.
  dismissible BOOLEAN NOT NULL DEFAULT true,

  active      BOOLEAN NOT NULL DEFAULT true,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every config fetch asks this question, so it is worth an index: which
-- announcements for this app are switched on.
CREATE INDEX IF NOT EXISTS announcements_lookup_idx
  ON announcements (app_slug, platform)
  WHERE active;

-- ── Rating prompt ───────────────────────────────────────────────────────────
--
-- JSONB for the same reason ad_pacing is: these are knobs, and a new one
-- should be a value the client already knows how to read rather than a schema
-- change plus a deploy plus a release.
--
-- iOS allows a limited number of review prompts per year. Asking at the wrong
-- moment burns one and costs a review, so the timing belongs somewhere it can
-- be corrected in an afternoon.
ALTER TABLE app_platforms
  ADD COLUMN IF NOT EXISTS rating_prompt JSONB NOT NULL DEFAULT '{
    "enabled": false,
    "minSessions": 5,
    "minDaysInstalled": 3,
    "cooldownDays": 90
  }'::jsonb;

-- ── Release notes ───────────────────────────────────────────────────────────
--
-- Shown once after an update. Keyed by the version they describe, so a client
-- asks for its own rather than being handed whatever is newest - someone who
-- skipped two releases should see the notes for what they are actually running.
CREATE TABLE IF NOT EXISTS release_notes (
  app_slug    TEXT NOT NULL REFERENCES apps (slug) ON DELETE CASCADE,
  platform    TEXT CHECK (platform IN ('ios', 'android')),
  version     TEXT NOT NULL,

  title       TEXT,
  body        TEXT NOT NULL,

  -- Written ahead of a release and switched on when it ships, rather than
  -- being typed in a hurry once the build is live.
  published   BOOLEAN NOT NULL DEFAULT false,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per version per scope, treating NULL platform as a real value - a
-- plain UNIQUE would allow unlimited NULL-platform duplicates for one version.
CREATE UNIQUE INDEX IF NOT EXISTS release_notes_scope_idx
  ON release_notes (app_slug, version, COALESCE(platform, '*'));
