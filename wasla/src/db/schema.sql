-- Wasla. Every statement is IF NOT EXISTS: this runs on every boot.

CREATE TABLE IF NOT EXISTS questions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  answer      TEXT NOT NULL,
  clue        TEXT NOT NULL,
  -- Unused legacy: replaced by title (src/db/index.js backfills title from it
  -- once). Kept so existing databases match; nothing writes it any more.
  category    TEXT,
  -- Shown above the question in the app. Older databases get it from index.js.
  title       TEXT,
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
  -- Unused legacy: levels have no names ("Level 3" by position). New levels store ''.
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

-- ── v3 ──────────────────────────────────────────────────────────────────────

-- The players dashboard: distinct devices per day, first-seen day per device
-- (retention) and help counts over a window. Covering, so none reads the rows.
CREATE INDEX IF NOT EXISTS idx_events_received_device ON events(received_at, device);
CREATE INDEX IF NOT EXISTS idx_events_device_received ON events(device, received_at);
CREATE INDEX IF NOT EXISTS idx_events_type_received ON events(type, received_at);
CREATE INDEX IF NOT EXISTS idx_events_level_device ON events(type, level_id, device);

-- Where to push. One row per install (`device` is the same random id events
-- carry). `enabled` 0 means the player turned notifications off: the row stays,
-- nothing is sent. APNs saying the token is dead also sets it to 0.
CREATE TABLE IF NOT EXISTS devices (
  device       TEXT PRIMARY KEY,
  token        TEXT NOT NULL,             -- APNs device token, lower-case hex
  platform     TEXT NOT NULL DEFAULT 'ios',
  environment  TEXT NOT NULL CHECK (environment IN ('production', 'sandbox')),
  enabled      INTEGER NOT NULL DEFAULT 1,
  locale       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_error   TEXT,                      -- APNs' reason on the last failed send
  failures     INTEGER NOT NULL DEFAULT 0 -- failed sends since the last success
);

CREATE INDEX IF NOT EXISTS idx_devices_enabled ON devices(enabled, environment);
CREATE INDEX IF NOT EXISTS idx_devices_token ON devices(token);

-- Every notification sent from the panel, with what came of it.
CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  level       INTEGER,                    -- public level number the tap opens, or NULL
  target      TEXT NOT NULL,              -- all | sandbox | device
  device      TEXT,                       -- the one device, for a test send
  total       INTEGER NOT NULL DEFAULT 0,
  sent        INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  disabled    INTEGER NOT NULL DEFAULT 0,
  errors      TEXT,                       -- JSON: APNs reason → count
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── v4 ──────────────────────────────────────────────────────────────────────

-- Question titles kept out of the daily word search. A title is a theme once it
-- has enough questions; a row here skips it (matched on the trimmed title).
CREATE TABLE IF NOT EXISTS wordsearch_excluded_titles (
  title       TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The daily games' word lists (guess, wheel) once edited in the panel; a missing row reads as the built-in list.
-- A daily game fixed for a date in the panel (planned or typed); a date and game without a row
-- is automatic. `game` is the JSON the API sends for that game.
CREATE TABLE IF NOT EXISTS daily_game_days (
  date        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('scramble', 'bubbles', 'groups', 'wheel', 'guess')),
  game        TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'typed')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (date, kind)
);

CREATE TABLE IF NOT EXISTS daily_game_lists (
  name        TEXT PRIMARY KEY,
  body        TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── v5 ──────────────────────────────────────────────────────────────────────

-- The daily word search planned in the panel: one frozen board per date. A
-- date with a row serves exactly this board (coins from the current config);
-- a date without one gets the automatic board. Editing questions never
-- changes a row here.
CREATE TABLE IF NOT EXISTS wordsearch_days (
  date        TEXT PRIMARY KEY,           -- YYYY-MM-DD
  theme       TEXT NOT NULL,
  size        INTEGER NOT NULL,           -- 7 … 10
  words       TEXT NOT NULL,              -- JSON [{ id | null, word, display }]; id null for a typed word
  seed        INTEGER NOT NULL,
  board       TEXT NOT NULL,              -- JSON { theme, size, rows, words }: the API payload minus date and coins
  source      TEXT NOT NULL DEFAULT 'theme', -- theme | custom
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Player profiles (contract §7): a public username, no email or password. The app
-- keeps a random token (only its SHA-256 is stored here) and sends it to act as the profile.
CREATE TABLE IF NOT EXISTS profiles (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  username          TEXT NOT NULL,
  username_key      TEXT NOT NULL UNIQUE,      -- lower-case, hamza forms and digits folded
  avatar            TEXT NOT NULL,
  token_hash        TEXT NOT NULL UNIQUE,
  recovery_hash     TEXT,                      -- SHA-256 of the recovery code shown once in the app
  points            INTEGER NOT NULL DEFAULT 0,
  levels_completed  INTEGER NOT NULL DEFAULT 0,
  words_solved      INTEGER NOT NULL DEFAULT 0,
  streak            INTEGER NOT NULL DEFAULT 0,
  best_streak       INTEGER NOT NULL DEFAULT 0,
  streak_date       TEXT,                      -- the player's last daily completion, YYYY-MM-DD
  banned            INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  stats_updated_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_profiles_points ON profiles(points DESC);

-- One row per profile and date: the word search time and the all-games time, each set once.
CREATE TABLE IF NOT EXISTS profile_daily (
  profile_id          INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  date                TEXT NOT NULL,
  wordsearch_seconds  INTEGER,
  wordsearch_at       TEXT,
  allgames_seconds    INTEGER,
  allgames_at         TEXT,
  PRIMARY KEY (profile_id, date)
);

CREATE INDEX IF NOT EXISTS idx_profile_daily_date ON profile_daily(date);

CREATE TABLE IF NOT EXISTS profile_badges (
  profile_id  INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  badge       TEXT NOT NULL,
  earned_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (profile_id, badge)
);
