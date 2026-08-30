-- ── App Store Connect credentials ───────────────────────────────────────────
--
-- One key per app rather than one per install: apps can sit under different
-- Apple teams, and a single shared key would mean the panel could only ever
-- show whichever team it belonged to.
--
-- The private key is the .p8 downloaded from App Store Connect. It is stored
-- encrypted with SETTINGS_KEY, the same way `settings.secret_value` is, and it
-- is never sent back to the browser — Apple lets you download it exactly once,
-- so a panel that could display it would be a far better target than the panel
-- is worth.

CREATE TABLE IF NOT EXISTS appstore_credentials (
  app_slug     TEXT PRIMARY KEY REFERENCES apps(slug) ON DELETE CASCADE,

  issuer_id    TEXT NOT NULL,
  key_id       TEXT NOT NULL,

  -- nonce:tag:ciphertext, base64.
  private_key  TEXT NOT NULL,

  -- Needed only for sales reports, which are a different API with a different
  -- role requirement. Null is normal.
  vendor_number TEXT,

  updated_by   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
