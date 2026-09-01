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

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  platform_id   INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
