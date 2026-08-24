-- Remote configuration for every app on this VPS.
--
-- The shape is driven by one question: what does an app need to be told at
-- launch that would otherwise require a store release? Ad unit ids, a kill
-- switch, a forced-update floor, and feature flags. Everything else belongs in
-- that app's own backend.
--
-- Idempotent throughout, so re-running a partial migration is safe.

-- ── Apps ────────────────────────────────────────────────────────────────────
--
-- `slug` is the identifier the client sends, e.g. /v1/apps/brawl-stats/config.
-- Deliberately not a numeric id: it appears in URLs and in client code, where a
-- readable name is worth more than a compact one.
CREATE TABLE IF NOT EXISTS apps (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Per-platform settings ───────────────────────────────────────────────────
--
-- iOS and Android differ in every field that matters here: different AdMob app
-- ids, different bundle ids, different store URLs, and versions that ship at
-- different times. One row per pair rather than a column pair per field.
CREATE TABLE IF NOT EXISTS app_platforms (
  app_slug              TEXT NOT NULL REFERENCES apps (slug) ON DELETE CASCADE,
  platform              TEXT NOT NULL CHECK (platform IN ('ios', 'android')),

  bundle_id             TEXT,
  store_url             TEXT,

  -- The `~` id from AdMob → Settings → App ID. Not an ad unit; the SDK reads it
  -- at launch and crashes without it, which is why it lives here alongside the
  -- units rather than somewhere separate.
  admob_app_id          TEXT,

  -- Master switch. Turning ads off for one app on one platform is the fastest
  -- response to an AdMob policy warning, and it needs no release.
  ads_enabled           BOOLEAN NOT NULL DEFAULT true,

  latest_version        TEXT,
  -- Below this the client should refuse to continue. The floor, not the latest.
  min_supported_version TEXT,

  maintenance           BOOLEAN NOT NULL DEFAULT false,
  maintenance_message   TEXT,

  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (app_slug, platform)
);

-- ── Ad units ────────────────────────────────────────────────────────────────
--
-- One row per placement so a single unit can be swapped or disabled without
-- touching the others — which is what you want at 2am when one placement is
-- being flagged and the rest are fine.
CREATE TABLE IF NOT EXISTS ad_units (
  app_slug    TEXT NOT NULL,
  platform    TEXT NOT NULL,
  -- Free text rather than an enum: a new AdMob format should not need a
  -- migration before it can be configured.
  placement   TEXT NOT NULL,
  unit_id     TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (app_slug, platform, placement),
  FOREIGN KEY (app_slug, platform)
    REFERENCES app_platforms (app_slug, platform) ON DELETE CASCADE
);

-- ── Ad pacing ───────────────────────────────────────────────────────────────
--
-- JSON rather than columns. Pacing knobs are the thing most likely to grow, and
-- a new one should be a value the client already knows how to read rather than
-- a schema change plus a deploy plus a release.
CREATE TABLE IF NOT EXISTS ad_pacing (
  app_slug    TEXT NOT NULL,
  platform    TEXT NOT NULL,
  settings    JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (app_slug, platform),
  FOREIGN KEY (app_slug, platform)
    REFERENCES app_platforms (app_slug, platform) ON DELETE CASCADE
);

-- ── Feature flags ───────────────────────────────────────────────────────────
--
-- `platform` NULL means both. Most flags apply everywhere, and forcing two rows
-- for every one of them invites the two drifting apart.
CREATE TABLE IF NOT EXISTS feature_flags (
  app_slug    TEXT NOT NULL REFERENCES apps (slug) ON DELETE CASCADE,
  platform    TEXT CHECK (platform IN ('ios', 'android')),
  key         TEXT NOT NULL,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enforces "one row per flag per scope" while treating NULL as a real value —
-- a plain UNIQUE would let unlimited NULL-platform duplicates through.
CREATE UNIQUE INDEX IF NOT EXISTS feature_flags_scope_idx
  ON feature_flags (app_slug, key, COALESCE(platform, '*'));

-- ── Fetch log ───────────────────────────────────────────────────────────────
--
-- Counters only, no identifiers. Enough to answer "did the rollout reach
-- anyone" and "is this app still alive" without collecting anything about a
-- person.
CREATE TABLE IF NOT EXISTS config_fetches (
  app_slug    TEXT NOT NULL,
  platform    TEXT NOT NULL,
  day         DATE NOT NULL,
  app_version TEXT,
  hits        BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (app_slug, platform, day, app_version)
);

CREATE INDEX IF NOT EXISTS config_fetches_day_idx ON config_fetches (day DESC);
