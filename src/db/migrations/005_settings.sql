-- Service settings, moved out of .env.
--
-- One row per service per key. The value is JSONB rather than text so a number
-- stays a number: a service comparing "9" > "16" as strings gets the wrong
-- answer, and a setting that silently means something else is worse than one
-- that is missing.
--
-- Secrets are stored encrypted in `secret_value` and never in `value`. Keeping
-- them in a separate column means a query that selects `value` cannot leak one
-- by accident, and the panel's read path never touches the other column.

CREATE TABLE IF NOT EXISTS settings (
  service     TEXT NOT NULL,
  key         TEXT NOT NULL,

  -- Ordinary values. NULL when this row holds a secret.
  value       JSONB,

  -- nonce:tag:ciphertext, base64. NULL when this row holds a plain value.
  secret_value TEXT,

  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (service, key),

  -- Exactly one of the two, always. A row with both would make "is this a
  -- secret" a question with two answers.
  CONSTRAINT settings_one_value CHECK (
    (value IS NOT NULL AND secret_value IS NULL)
    OR (value IS NULL AND secret_value IS NOT NULL)
  )
);

-- Every service fetches its own set on boot and on a timer; this is the only
-- query that matters.
CREATE INDEX IF NOT EXISTS settings_service_idx ON settings (service);

-- ── History ─────────────────────────────────────────────────────────────────
--
-- What changed, when, and by whom. Not the value itself for a secret - the
-- point of encrypting it is defeated by a history table holding every previous
-- one in the clear.
CREATE TABLE IF NOT EXISTS settings_history (
  id          BIGSERIAL PRIMARY KEY,
  service     TEXT NOT NULL,
  key         TEXT NOT NULL,

  -- NULL for a secret; the row still records that it was changed.
  old_value   JSONB,
  new_value   JSONB,
  is_secret   BOOLEAN NOT NULL DEFAULT false,

  changed_by  TEXT,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS settings_history_lookup_idx
  ON settings_history (service, changed_at DESC);
