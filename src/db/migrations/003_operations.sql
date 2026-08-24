-- Operational controls: test ads, scheduled changes, and outage alerts.

-- ── Test-ad mode ────────────────────────────────────────────────────────────
--
-- Serves Google's test unit IDs instead of the real ones, per app per platform.
-- Two reasons it belongs here rather than in the client: testing ads otherwise
-- means a rebuild, and a review build showing live ads risks a policy strike -
-- neither should need a release to fix.
ALTER TABLE app_platforms
  ADD COLUMN IF NOT EXISTS test_ads BOOLEAN NOT NULL DEFAULT false;

-- ── Scheduled changes ───────────────────────────────────────────────────────
--
-- "Ads off Friday evening, on again Monday." A row states one field to change
-- and when; a sweep applies whatever is due. Stored as the same JSON shape the
-- write routes already take, so applying one is the same code path as a person
-- clicking save rather than a second way to write the same field.
CREATE TABLE IF NOT EXISTS scheduled_changes (
  id          BIGSERIAL PRIMARY KEY,
  app_slug    TEXT NOT NULL REFERENCES apps (slug) ON DELETE CASCADE,
  platform    TEXT CHECK (platform IN ('ios', 'android')),

  -- What to change. Matches the dashboard's own vocabulary: 'platform' for the
  -- app_platforms fields, 'flag' for a feature flag.
  kind        TEXT NOT NULL CHECK (kind IN ('platform', 'flag')),
  payload     JSONB NOT NULL,

  run_at      TIMESTAMPTZ NOT NULL,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- NULL until applied. Kept rather than deleted so the audit trail can say
  -- what a change was scheduled to do, not only that something happened.
  applied_at  TIMESTAMPTZ,
  error       TEXT,
  note        TEXT
);

-- The sweep asks one question every minute: what is due and not yet applied.
CREATE INDEX IF NOT EXISTS scheduled_changes_due_idx
  ON scheduled_changes (run_at)
  WHERE applied_at IS NULL;

-- ── Alerting ────────────────────────────────────────────────────────────────
--
-- Health checks have been recording status for a while and telling nobody. One
-- destination per row so a webhook and an email can both exist, and so turning
-- one off does not mean deleting it and retyping the URL later.
CREATE TABLE IF NOT EXISTS alert_targets (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('webhook', 'telegram')),

  -- A webhook URL, or a Telegram bot token. Secret in the Telegram case, which
  -- is why nothing returns this column to the browser.
  target      TEXT NOT NULL,
  -- Telegram only: the chat to post into.
  chat_id     TEXT,

  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sent_at TIMESTAMPTZ,
  last_error  TEXT
);

-- ── Alert state ─────────────────────────────────────────────────────────────
--
-- Remembers what each service was last seen as, so a notification is sent on a
-- change rather than every minute a service stays down. Without this an outage
-- is a message a minute until someone wakes up.
CREATE TABLE IF NOT EXISTS service_alert_state (
  service_slug  TEXT PRIMARY KEY,
  last_status   TEXT NOT NULL,
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at   TIMESTAMPTZ
);
