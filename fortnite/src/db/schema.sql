-- ── Upstream catalogue, cached ──────────────────────────────────────────────
--
-- The cosmetics endpoint is a single 16 MB document of about sixteen thousand
-- items. An app cannot download that on launch and a phone should not be the
-- thing that filters it, so it is unpacked into rows here and served back
-- paginated, searched and filtered.
--
-- Everything in this table is a copy of someone else's data and can be thrown
-- away and re-fetched. Nothing here is authored, which is why there is no
-- created_by and no history.

CREATE TABLE IF NOT EXISTS cosmetics (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  type          TEXT,
  type_name     TEXT,

  -- The API's rarity value: common…mythic, plus the themed tiers (dark, lava,
  -- frozen, shadow, slurp) and the partnership ones (marvel, dc, starwars,
  -- icon, gaminglegends). The app colours from this.
  rarity        TEXT,
  rarity_name   TEXT,

  -- Present only on partnership and themed items, and worded differently from
  -- rarity ("MARVEL SERIES" against "marvel"), so both are kept: series wins
  -- when it exists, rarity is the fallback.
  series        TEXT,

  set_name      TEXT,
  introduction  TEXT,
  season        TEXT,
  icon_url      TEXT,
  featured_url  TEXT,
  small_icon_url TEXT,
  added_at      TEXT,

  -- Lowercased name and set, so search does not pay for LOWER() per row.
  search_blob   TEXT NOT NULL DEFAULT '',
  synced_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cosmetics_type   ON cosmetics(type);
CREATE INDEX IF NOT EXISTS idx_cosmetics_rarity ON cosmetics(rarity);
CREATE INDEX IF NOT EXISTS idx_cosmetics_series ON cosmetics(series);
CREATE INDEX IF NOT EXISTS idx_cosmetics_added  ON cosmetics(added_at DESC);
CREATE INDEX IF NOT EXISTS idx_cosmetics_search ON cosmetics(search_blob);

-- One row per shop offer for the current rotation. Replaced wholesale on every
-- sync rather than merged: the shop is a snapshot, and a merge would leave
-- yesterday's offers behind whenever an item stopped being sold.
CREATE TABLE IF NOT EXISTS shop_entries (
  offer_id      TEXT PRIMARY KEY,
  shop_date     TEXT NOT NULL,
  regular_price INTEGER NOT NULL DEFAULT 0,
  final_price   INTEGER NOT NULL DEFAULT 0,
  in_date       TEXT,
  out_date      TEXT,
  giftable      INTEGER NOT NULL DEFAULT 0,
  layout_name   TEXT,
  tile_size     TEXT,
  sort_priority INTEGER NOT NULL DEFAULT 0,

  -- The cosmetics in this offer, as JSON. A bundle can hold several and the
  -- app draws them together, so a join table would be split apart again on
  -- every read.
  items_json    TEXT NOT NULL DEFAULT '[]',
  synced_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_shop_sort ON shop_entries(sort_priority DESC, offer_id);

CREATE TABLE IF NOT EXISTS news (
  id          TEXT PRIMARY KEY,
  title       TEXT,
  body        TEXT,
  tab_title   TEXT,
  image_url   TEXT,
  tile_url    TEXT,
  priority    INTEGER NOT NULL DEFAULT 0,
  synced_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- When each upstream feed was last pulled, and whether it worked. Read by the
-- health endpoint and by the panel, so a feed that has been quietly failing for
-- a day is visible without reading logs.
CREATE TABLE IF NOT EXISTS sync_state (
  feed        TEXT PRIMARY KEY,
  last_ok_at  TEXT,
  last_try_at TEXT,
  last_error  TEXT,
  item_count  INTEGER NOT NULL DEFAULT 0
);

-- ── Authored content ────────────────────────────────────────────────────────
--
-- Everything below is written in the panel rather than fetched. It is the
-- reason this service exists at all rather than the app calling upstream
-- directly: leaks, wallpapers, map codes and weapon stats have no public API.

CREATE TABLE IF NOT EXISTS leaks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  body        TEXT,
  image_url   TEXT,
  source      TEXT,
  is_published INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wallpapers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  image_url   TEXT NOT NULL,
  thumb_url   TEXT,
  is_published INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS creative_maps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  code        TEXT NOT NULL,
  -- Live player count at import time. A snapshot, not a live figure: it says
  -- how popular a map was when the list was pasted, which is what makes it
  -- worth featuring, and the app labels it as such.
  players     INTEGER,
  category    TEXT,
  description TEXT,
  image_url   TEXT,
  is_published INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS weapons (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  rarity      TEXT NOT NULL DEFAULT 'common',
  category    TEXT,
  dps         REAL,
  damage      REAL,
  fire_rate   REAL,
  magazine    INTEGER,
  reload_time REAL,
  image_url   TEXT,
  description TEXT,
  is_published INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Panel accounts. `password_hash` is null for anyone who only ever signs in
-- through the platform: there is no local password to check, and storing a
-- placeholder would be a credential that looks real.
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

-- ── Epic's island catalogue ─────────────────────────────────────────────────
--
-- From api.fortnite.com/ecosystem/v1 — Epic's own public API, no key required.
-- Twenty thousand islands and counting, so this is a mirror rather than a
-- pass-through: the app needs to search and sort it, and the upstream offers
-- neither. Every query parameter it accepts is ignored.

CREATE TABLE IF NOT EXISTS islands (
  code          TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  creator_code  TEXT,
  category      TEXT,
  created_in    TEXT,
  tags          TEXT NOT NULL DEFAULT '[]',

  -- Denormalised from the newest metrics row.
  --
  -- Sorting by "most played" means ordering twenty thousand islands by a value
  -- in another table, and doing that as a join on every request is the
  -- difference between a list that opens instantly and one that does not.
  peak_ccu      INTEGER,
  unique_players INTEGER,
  plays         INTEGER,
  minutes_played INTEGER,
  favorites     INTEGER,
  recommendations INTEGER,
  avg_minutes   REAL,
  retention     REAL,
  metrics_at    TEXT,
  -- How many times this island has been asked for metrics and returned
  -- nothing. Epic publishes numbers only for islands above some popularity
  -- line, and most of the catalogue is below it — so without backing off, the
  -- rotation spends nearly every request re-confirming the same silence.
  metrics_misses INTEGER NOT NULL DEFAULT 0,

  search_blob   TEXT NOT NULL DEFAULT '',
  first_seen    TEXT NOT NULL DEFAULT (datetime('now')),
  synced_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_islands_ccu     ON islands(peak_ccu DESC);
CREATE INDEX IF NOT EXISTS idx_islands_players ON islands(unique_players DESC);
CREATE INDEX IF NOT EXISTS idx_islands_search  ON islands(search_blob);
CREATE INDEX IF NOT EXISTS idx_islands_metrics ON islands(metrics_at);

-- One row per island per day.
--
-- The upstream only returns the last two days, so history exists only if it is
-- kept. Poll daily and this becomes something the API itself cannot give you:
-- a record going back as far as the service has been running.
CREATE TABLE IF NOT EXISTS island_metrics (
  code          TEXT NOT NULL,
  day           TEXT NOT NULL,
  peak_ccu      INTEGER,
  unique_players INTEGER,
  plays         INTEGER,
  minutes_played INTEGER,
  avg_minutes   REAL,
  favorites     INTEGER,
  recommendations INTEGER,
  retention     REAL,
  recorded_at   TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (code, day)
);

CREATE INDEX IF NOT EXISTS idx_island_metrics_day ON island_metrics(day DESC);
