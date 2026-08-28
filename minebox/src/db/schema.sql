-- MineBox catalogue schema.
--
-- One `items` table for five kinds of content — skins, addons, texture packs, worlds and
-- seeds — rather than a table each.
--
-- The alternative was considered and rejected. Everything the catalogue actually does is
-- kind-agnostic: search, tags, downloads, reactions, reports, featuring, the trending sort,
-- the audit trail. Five tables would mean five copies of each of those and a UNION in every
-- list query, to buy strictness over a handful of columns that only one kind uses. Those
-- columns are nullable here instead, and `kind` is the discriminator the app filters on.
--
-- Two other choices worth knowing about:
--   * `downloads` is denormalised onto `items` as a running counter, while `download_events`
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
  -- items.created_by, audit_log.user_id and reports.resolved_by are foreign keys into this
  -- table, so a signed-in person must exist here before they can create or change anything.
  -- Under SSO they exist in platform-api instead, and their id there means nothing here.
  platform_id   INTEGER
);

-- The unique index on platform_id is created in index.js, not here. This file is applied
-- before the ensureColumn calls that add columns to tables which already exist, so an index
-- naming platform_id would fail with "no such column" on every existing install.

CREATE TABLE IF NOT EXISTS items (
  id            TEXT PRIMARY KEY,

  -- What this is. The app's top-level tabs, and the only axis every query filters on.
  kind          TEXT NOT NULL CHECK (kind IN ('skin', 'addon', 'texture', 'world', 'seed')),

  -- Sub-filter within a kind: 'mobs' under addons, 'parkour' under worlds. Deliberately not
  -- a CHECK constraint — the valid set depends on `kind` and grows as the catalogue does,
  -- and a CHECK across all five kinds would need a table rebuild every time one is added.
  -- `utils/validate.js` is the single source of truth and the only writer.
  category      TEXT NOT NULL,

  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',

  -- Which Minecraft this is for. Bedrock is the one that matters on iOS: a .mcaddon opens
  -- straight into the game from the share sheet, while a Java .jar cannot be installed on a
  -- phone at all. Java items are therefore browse-and-share, never install, and the app is
  -- told which is which rather than guessing from the extension.
  edition       TEXT NOT NULL DEFAULT 'bedrock' CHECK (edition IN ('bedrock', 'java', 'both')),
  -- Free text ('1.21', '1.20.80'). Version strings are compared by humans, not by the
  -- database, and a numeric scheme would have to be rewritten the first time Mojang ships
  -- something that does not fit it.
  mc_version    TEXT,

  -- ── The payload ─────────────────────────────────────────────────────────────
  --
  -- Null for seeds, which are a number rather than a file. Everything else has exactly one.
  file_name     TEXT,
  -- What it was called when it was uploaded. Served as the download filename, because
  -- Minecraft shows the pack under whatever the file is called and 'a7f3c9d2e1b4.mcaddon'
  -- is not a name anyone wants in their pack list.
  original_name TEXT,
  file_ext      TEXT,
  file_bytes    INTEGER NOT NULL DEFAULT 0,

  -- Card artwork. Always present: derived from the skin texture, lifted out of the pack's
  -- own pack_icon.png, or uploaded by hand.
  preview_file  TEXT NOT NULL,

  -- ── Skins only ──────────────────────────────────────────────────────────────
  --
  -- 'classic' (4px arms, Steve) or 'slim' (3px arms, Alex). The two are not
  -- interchangeable: a slim skin worn on a classic model has a one-pixel seam down each arm.
  skin_model    TEXT CHECK (skin_model IS NULL OR skin_model IN ('classic', 'slim')),
  skin_w        INTEGER,
  skin_h        INTEGER,

  -- ── Packs only ──────────────────────────────────────────────────────────────
  --
  -- What the pack's own manifest.json says: name, uuid, version, and whether its modules are
  -- resources, data or both. Read out of the archive at upload time so the panel can show
  -- what the game will show, and so a .mcaddon whose manifest is missing or unreadable is
  -- caught here rather than by a player whose import silently fails. JSON, because its shape
  -- follows Mojang's format_version rather than ours.
  pack_meta     TEXT,

  -- ── Seeds only ──────────────────────────────────────────────────────────────
  seed_code     TEXT,
  -- Coordinates worth going to: [{ "label": "Village", "x": 120, "y": 68, "z": -340 }].
  seed_meta     TEXT,

  -- Dominant colour of the preview, for the app's colour chips. Stored as HSL plus the hex
  -- rather than as a bucket name, so the buckets can be retuned without re-processing
  -- every upload.
  color_hue     REAL,
  color_sat     REAL,
  color_light   REAL,
  color_hex     TEXT,

  downloads     INTEGER NOT NULL DEFAULT 0,
  -- Kept alongside the reactions they summarise and recomputed from them on every write.
  -- Sorting and listing read these; counting rows for each of twenty-four cards would not
  -- survive a catalogue worth having.
  likes         INTEGER NOT NULL DEFAULT 0,
  dislikes      INTEGER NOT NULL DEFAULT 0,

  is_featured   INTEGER NOT NULL DEFAULT 0,
  is_published  INTEGER NOT NULL DEFAULT 1,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- `kind` leads every composite index because every catalogue query filters on it first:
-- the app asks for skins, or addons, never for "everything sorted by downloads".
CREATE INDEX IF NOT EXISTS idx_items_kind       ON items(kind);
CREATE INDEX IF NOT EXISTS idx_items_kind_cat   ON items(kind, category);
CREATE INDEX IF NOT EXISTS idx_items_published  ON items(is_published, kind);
CREATE INDEX IF NOT EXISTS idx_items_featured   ON items(is_featured);
CREATE INDEX IF NOT EXISTS idx_items_downloads  ON items(kind, downloads DESC);
CREATE INDEX IF NOT EXISTS idx_items_created_at ON items(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_version    ON items(mc_version);
CREATE INDEX IF NOT EXISTS idx_items_color      ON items(color_hue);

CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS item_tags (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_item_tags_tag ON item_tags(tag_id);

CREATE TABLE IF NOT EXISTS download_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  client_key TEXT
);

CREATE INDEX IF NOT EXISTS idx_download_events_day  ON download_events(day);
CREATE INDEX IF NOT EXISTS idx_download_events_item ON download_events(item_id, day);

-- Every search the app runs, with how many results came back.
--
-- The zero-result rows are the point: they are a direct, ranked list of what people want and
-- the catalogue doesn't have — far better product direction than guessing from what does sell.
CREATE TABLE IF NOT EXISTS search_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  term       TEXT NOT NULL,
  kind       TEXT,
  results    INTEGER NOT NULL,
  day        TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_search_term ON search_events(term);
CREATE INDEX IF NOT EXISTS idx_search_zero ON search_events(results, day);

-- How people reacted to an item.
--
-- One row per client per item, not one per tap: a reaction is an opinion, and an opinion can
-- be changed or withdrawn. Uniqueness is enforced by the index rather than by reading before
-- writing, which would race two taps against each other.
--
-- `value` is 1 or -1. Withdrawing removes the row rather than storing a zero, so "has no
-- opinion" and "has never seen it" are the same thing, which is what they are.
CREATE TABLE IF NOT EXISTS reactions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  client_key TEXT NOT NULL,
  value      INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reactions_client ON reactions(item_id, client_key);

-- Session store. Kept in the same database so a restart doesn't sign every admin out, and so
-- there's exactly one file to back up.
CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- Player-submitted reports.
--
-- Kept separate from the audit log: that records what staff did, this records what the
-- catalogue got wrong. An addon that crashes on import is invisible from the server's side —
-- the archive is well-formed and the manifest parses. The only signal is someone saying so.
CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  client_key  TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  day         TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_item   ON reports(item_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);
-- One report per client per item per day; enforced here rather than in a read-then-write,
-- which would race under concurrent submissions.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_dedupe
  ON reports(item_id, client_key, day) WHERE client_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  subject    TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
