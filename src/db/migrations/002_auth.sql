-- Accounts, sessions, roles, audit and config history.
--
-- Replaces the single ADMIN_KEY-in-the-URL model. A key in a query string ends
-- up in browser history, bookmarks, nginx access logs and every screenshot of
-- the panel ever taken — and it is all-or-nothing, so there is no way to hand
-- someone one app without handing them every app.
--
-- Idempotent throughout.

-- ── Users ───────────────────────────────────────────────────────────────────
--
-- `role` is the account-wide role. `app_admin` grants nothing on its own — it
-- is a promise that the grants in user_app_roles are the whole of that user's
-- access, which is what makes "admin for one app" expressible.
CREATE TABLE IF NOT EXISTS users (
  id             BIGSERIAL PRIMARY KEY,
  email          TEXT NOT NULL,
  name           TEXT,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'viewer'
                 CHECK (role IN ('owner', 'admin', 'app_admin', 'viewer')),

  -- Set, then required at next sign-in. Optional per account rather than
  -- forced, so adding it cannot lock out the only owner.
  totp_secret    TEXT,
  totp_enabled   BOOLEAN NOT NULL DEFAULT false,

  disabled       BOOLEAN NOT NULL DEFAULT false,

  -- Lockout state. Counted per account rather than per IP: an attacker rotates
  -- addresses far more easily than they guess a password.
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at  TIMESTAMPTZ
);

-- Case-insensitive uniqueness without the citext extension, which is not
-- installed on every Postgres and would need superuser to add.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (lower(email));

-- ── Sessions ────────────────────────────────────────────────────────────────
--
-- Server-side rather than a signed stateless cookie. The difference that
-- matters is revocation: an admin who leaves, or a laptop that is lost, has to
-- be cut off now — and you cannot un-issue a self-contained token.
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  ip            TEXT,
  user_agent    TEXT,
  -- Double-submit CSRF token, issued with the session and required on writes.
  csrf          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

-- ── Per-app grants ──────────────────────────────────────────────────────────
--
-- Only consulted for `app_admin` and `viewer`. An owner or admin needs no rows
-- here, and adding some would imply a restriction that is not enforced.
CREATE TABLE IF NOT EXISTS user_app_roles (
  user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  app_slug   TEXT NOT NULL REFERENCES apps (slug) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'app_admin'
             CHECK (role IN ('app_admin', 'viewer')),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, app_slug)
);

-- ── Audit log ───────────────────────────────────────────────────────────────
--
-- The email is denormalised on purpose. "Who turned ads off at 3am" must stay
-- answerable after that account is deleted, and a dangling user_id answers
-- nothing.
CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL PRIMARY KEY,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id      BIGINT,
  user_email   TEXT,
  action       TEXT NOT NULL,
  target_type  TEXT,
  target_id    TEXT,
  detail       JSONB,
  ip           TEXT
);

CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS audit_log_target_idx ON audit_log (target_type, target_id, at DESC);

-- ── Config history ──────────────────────────────────────────────────────────
--
-- A full snapshot per change rather than a diff. Config is small, and a
-- snapshot restores in one statement while a chain of diffs has to be replayed
-- correctly — which is exactly the thing you cannot rely on at the moment you
-- need a rollback.
CREATE TABLE IF NOT EXISTS config_versions (
  id          BIGSERIAL PRIMARY KEY,
  app_slug    TEXT NOT NULL,
  platform    TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_email  TEXT,
  note        TEXT,
  snapshot    JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS config_versions_app_idx
  ON config_versions (app_slug, at DESC);

-- ── Services registry ───────────────────────────────────────────────────────
--
-- The other half of the dashboard: not the apps people install, but the things
-- running on this box that serve them.
CREATE TABLE IF NOT EXISTS services (
  slug          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  domain        TEXT,
  health_url    TEXT,
  systemd_unit  TEXT,
  repo_url      TEXT,
  notes         TEXT,
  -- Which app this backs, when it backs one. Lets the dashboard show an app
  -- and its server together rather than as two unrelated lists.
  app_slug      TEXT REFERENCES apps (slug) ON DELETE SET NULL,
  sort_order    INTEGER NOT NULL DEFAULT 100,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Health history. Bounded by a retention sweep rather than kept forever — the
-- useful window is "is it up now" and "was it flapping this week".
CREATE TABLE IF NOT EXISTS service_checks (
  id            BIGSERIAL PRIMARY KEY,
  service_slug  TEXT NOT NULL REFERENCES services (slug) ON DELETE CASCADE,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  ok            BOOLEAN NOT NULL,
  status_code   INTEGER,
  duration_ms   INTEGER,
  error         TEXT
);

CREATE INDEX IF NOT EXISTS service_checks_recent_idx
  ON service_checks (service_slug, at DESC);
