-- Wasla. Every statement is IF NOT EXISTS: this runs on every boot.

CREATE TABLE IF NOT EXISTS questions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  answer      TEXT NOT NULL,
  clue        TEXT NOT NULL,
  category    TEXT,
  -- A generated name under the images directory, never a path.
  image_file  TEXT,
  -- 1 shows the whole picture; above 1 is a close-up around the focus point,
  -- for "guess what this zoomed picture is" questions.
  image_zoom  REAL NOT NULL DEFAULT 1,
  focus_x     REAL NOT NULL DEFAULT 0.5,
  focus_y     REAL NOT NULL DEFAULT 0.5,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS levels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  -- Order in the app. The public level number is the rank among published ones.
  position    INTEGER NOT NULL,
  published   INTEGER NOT NULL DEFAULT 0,
  -- The layout seed; "shuffle" moves it on, so a saved grid is reproducible.
  seed        INTEGER NOT NULL DEFAULT 1,
  grid_rows   INTEGER NOT NULL DEFAULT 0,
  grid_cols   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A question in a level. row/col/direction are NULL for a word the layout
-- could not cross with the others; such a level cannot be published.
CREATE TABLE IF NOT EXISTS level_words (
  level_id    INTEGER NOT NULL REFERENCES levels(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
  grid_row    INTEGER,
  grid_col    INTEGER,
  direction   TEXT CHECK (direction IN ('across', 'down')),
  PRIMARY KEY (level_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_level_words_question ON level_words(question_id);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  role          TEXT NOT NULL DEFAULT 'admin',
  platform_id   INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_platform
  ON users(platform_id) WHERE platform_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- ── v2 ──────────────────────────────────────────────────────────────────────
-- Columns added to questions and levels are not here: CREATE TABLE IF NOT
-- EXISTS never adds a column to a table that already exists, so they are
-- listed in src/db/index.js, which adds whatever a database is missing.

-- Unused legacy: level packs were removed (levels are one numbered run). The
-- table stays so databases that have it keep booting; nothing reads or writes it.
CREATE TABLE IF NOT EXISTS packs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  -- From a fixed palette of the game's colours, as #RRGGBB.
  color       TEXT NOT NULL,
  -- An SF Symbol name from a fixed list; the app draws it, the panel cannot.
  icon        TEXT NOT NULL,
  position    INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A level chosen for a day's puzzle. Days without a row get an automatic pick.
CREATE TABLE IF NOT EXISTS daily_levels (
  date        TEXT PRIMARY KEY,           -- YYYY-MM-DD
  level_id    INTEGER NOT NULL REFERENCES levels(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What GET /api/v1/config returns, one JSON value per top-level key. A key
-- with no row reads as its default.
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Anonymous gameplay events. `device` is a random id the app makes per
-- install, kept only to count distinct players. Pruned after 180 days.
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  device       TEXT NOT NULL,
  type         TEXT NOT NULL,
  -- The public number the app sent (0 = daily puzzle), and the level it was at
  -- the time: numbers shift when levels are reordered, ids do not.
  level_number INTEGER,
  level_id     INTEGER,
  word         INTEGER,                   -- question id
  help         TEXT,
  seconds      REAL,
  stars        INTEGER,
  at           TEXT,                      -- the device's clock, as sent
  received_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Question stats group by word and count by type; level stats by level.
CREATE INDEX IF NOT EXISTS idx_events_word ON events(word, type) WHERE word IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_level ON events(type, level_id);
CREATE INDEX IF NOT EXISTS idx_events_received ON events(received_at);

-- An uploaded import waiting for confirmation: the checked rows, and the media
-- already stored for them. Abandoned ones are removed with their files.
CREATE TABLE IF NOT EXISTS imports (
  id          TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
