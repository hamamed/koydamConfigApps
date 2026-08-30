-- ── One App Store Connect key for the whole platform ────────────────────────
--
-- An earlier migration gave each app its own credential row. That was wrong
-- for how these keys work: a key is issued against an Apple *team*, and
-- `GET /v1/apps` returns every app that team owns. Per-app rows meant pasting
-- the same secret once per app, and meant every new app arrived needing setup
-- before it could show anything.
--
-- One row, set once. Any app with an iOS bundle id is covered the moment it is
-- added. A bundle id the key's team does not own simply returns nothing, which
-- is the right answer rather than an error.

CREATE TABLE IF NOT EXISTS appstore_account (
  -- Singleton. The CHECK is what makes it one: a second row has nowhere to go,
  -- so "which credential is current" can never become a question.
  id            BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),

  issuer_id     TEXT NOT NULL,
  key_id        TEXT NOT NULL,

  -- nonce:tag:ciphertext, base64.
  private_key   TEXT NOT NULL,

  -- Sales reports only: a different API with a different role requirement.
  vendor_number TEXT,

  updated_by    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The per-app table this replaces, if it ever existed.
--
-- Nothing is carried across, because there is nothing to carry: the migration
-- that created it was written and superseded on the same afternoon and never
-- ran against a live database. If one somehow holds a key, re-pasting it once
-- is a smaller price than the machinery to move it — and that machinery is
-- either a plpgsql block or a scratch table created solely to be dropped.
DROP TABLE IF EXISTS appstore_credentials;
