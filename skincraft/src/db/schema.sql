-- SkinCraft catalogue schema.
--
-- Notes on a couple of choices:
--   * `downloads` is denormalised onto `skins` as a running counter, while `download_events`
--     keeps the raw log. The API reads the counter (one integer, no aggregation) and the
--     dashboard charts read the log. Aggregating the whole log on every catalogue request
--     would be the first thing to fall over.
--   * Tags live in their own table rather than in a JSON blob, so search can use an index.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT,
  -- The platform-api account this row mirrors, when signing in through SSO.
  --
  -- skins.created_by, audit_log.user_id and reports.resolved_by are foreign
  -- keys into this table, so a signed-in person must exist here before they can
  -- create or change anything. Under SSO they exist in platform-api instead,
  -- and their id there means nothing here: the owner's happened to collide with
  -- the bootstrap admin's id 1, which is why this worked for exactly one person
  -- and failed with a foreign-key error for everyone granted access afterwards.
  platform_id   INTEGER
);

-- The unique index on platform_id is created in index.js, not here. This file
-- is applied before the ensureColumn calls that add columns to tables which
-- already exist, so an index naming platform_id would fail with "no such
-- column" on every existing install — that is, on boot, everywhere.

CREATE TABLE IF NOT EXISTS skins (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  category      TEXT NOT NULL CHECK (category IN ('shirt', 'pants', 'tshirt', 'avatar')),
  description   TEXT NOT NULL DEFAULT '',
  downloads     INTEGER NOT NULL DEFAULT 0,
  template_file TEXT NOT NULL,
  preview_file  TEXT NOT NULL,
  template_w    INTEGER,
  template_h    INTEGER,
  file_bytes    INTEGER NOT NULL DEFAULT 0,
  color_hue     REAL,
  color_sat     REAL,
  color_light   REAL,
  color_hex     TEXT,
  -- How an AI-designed skin came to look like this: the plan in words, the
  -- per-face directions, and the exact prompts sent. JSON, and null for
  -- anything uploaded or drawn by hand.
  design_meta   TEXT,
  -- Kept alongside the reactions they summarise, and recomputed from them on
  -- every write. Sorting and listing read these; counting rows for each of
  -- twenty-four cards would not survive a catalogue worth having.
  likes         INTEGER NOT NULL DEFAULT 0,
  dislikes      INTEGER NOT NULL DEFAULT 0,
  is_featured   INTEGER NOT NULL DEFAULT 0,
  is_published  INTEGER NOT NULL DEFAULT 1,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_skins_category   ON skins(category);
CREATE INDEX IF NOT EXISTS idx_skins_featured   ON skins(is_featured);
CREATE INDEX IF NOT EXISTS idx_skins_published  ON skins(is_published);
CREATE INDEX IF NOT EXISTS idx_skins_downloads  ON skins(downloads DESC);
CREATE INDEX IF NOT EXISTS idx_skins_created_at ON skins(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skins_color      ON skins(color_hue);

-- Every search the app runs, with how many results came back.
--
-- The zero-result rows are the point: they are a direct, ranked list of what people want and
-- the catalogue doesn't have — far better product direction than guessing from what does sell.
CREATE TABLE IF NOT EXISTS search_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  term       TEXT NOT NULL,
  category   TEXT,
  results    INTEGER NOT NULL,
  day        TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_search_term ON search_events(term);
CREATE INDEX IF NOT EXISTS idx_search_zero ON search_events(results, day);

CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS skin_tags (
  skin_id TEXT NOT NULL REFERENCES skins(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (skin_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_skin_tags_tag ON skin_tags(tag_id);

CREATE TABLE IF NOT EXISTS download_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  skin_id    TEXT NOT NULL REFERENCES skins(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  client_key TEXT
);

CREATE INDEX IF NOT EXISTS idx_download_events_day  ON download_events(day);
CREATE INDEX IF NOT EXISTS idx_download_events_skin ON download_events(skin_id, day);

-- Session store. Kept in the same database so a restart doesn't sign every admin out, and so
-- there's exactly one file to back up.
-- How people reacted to a skin.
--
-- One row per client per skin, not one per tap: a reaction is an opinion, and
-- an opinion can be changed or withdrawn. The uniqueness is enforced by the
-- index rather than by reading before writing, which would race two taps
-- against each other.
--
-- `value` is 1 or -1. Withdrawing removes the row rather than storing a zero,
-- so "has no opinion" and "has never seen it" are the same thing, which is what
-- they are.
CREATE TABLE IF NOT EXISTS reactions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  skin_id    TEXT NOT NULL REFERENCES skins(id) ON DELETE CASCADE,
  client_key TEXT NOT NULL,
  value      INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reactions_client
  ON reactions(skin_id, client_key);

CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- Player-submitted reports.
--
-- Kept separate from the audit log: that records what staff did, this records what the catalogue
-- got wrong. A template that doesn't line up in Roblox is invisible from the server's side —
-- the only signal is someone telling us.
CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  skin_id     TEXT NOT NULL REFERENCES skins(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  client_key  TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  day         TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_skin   ON reports(skin_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);
-- One report per client per skin per day; the uniqueness is enforced here rather than in a
-- read-then-write, which would race under concurrent submissions.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_dedupe
  ON reports(skin_id, client_key, day) WHERE client_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  subject    TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
