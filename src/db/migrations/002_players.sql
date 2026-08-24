-- Player universe, server-side history, and the discovery queue.
--
-- Still idempotent, still re-run on every boot: `ADD COLUMN IF NOT EXISTS` is
-- as safe to repeat as `CREATE TABLE IF NOT EXISTS`.

-- 001 created players_seen for the crawler's sampling frame. It is now the
-- app's player universe too — anyone searched, anyone met in a battle log —
-- so it needs more than a tag and a trophy count.
ALTER TABLE players_seen ADD COLUMN IF NOT EXISTS highest_trophies INTEGER;
ALTER TABLE players_seen ADD COLUMN IF NOT EXISTS club_tag  TEXT;
ALTER TABLE players_seen ADD COLUMN IF NOT EXISTS club_name TEXT;
ALTER TABLE players_seen ADD COLUMN IF NOT EXISTS icon_id   INTEGER;
ALTER TABLE players_seen ADD COLUMN IF NOT EXISTS exp_level INTEGER;

-- How this tag entered the system: 'ranking' (top of the ladder), 'search'
-- (someone looked them up in the app) or 'discovered' (met in someone else's
-- battle log). Kept because the three have very different value — a searched
-- player is one a human cares about, and should be refreshed more eagerly than
-- a stranger seen once in a lobby.
ALTER TABLE players_seen ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'ranking';

-- Null means never crawled. The queue orders by this, oldest first.
ALTER TABLE players_seen ADD COLUMN IF NOT EXISTS last_crawled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS players_seen_crawl_idx
  ON players_seen (last_crawled_at NULLS FIRST, last_seen DESC);

CREATE INDEX IF NOT EXISTS players_seen_source_idx
  ON players_seen (source);

-- Trophy history for any player the server has ever seen.
--
-- The app already keeps this locally, but that record dies with the install and
-- only covers profiles that device happened to open. Recording it here makes it
-- survive a reinstall, work across devices, and — the real win — exist for a
-- player the moment you first search them, because the crawler has probably
-- been watching them for weeks already.
CREATE TABLE IF NOT EXISTS player_snapshots (
  id               BIGSERIAL PRIMARY KEY,
  tag              TEXT NOT NULL,
  at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The hour `at` falls in, stored rather than derived.
  --
  -- The obvious index is on `date_trunc('hour', at)`, but that expression is
  -- only STABLE for a timestamptz — it depends on the session timezone — and
  -- Postgres refuses to index it. Writing the bucket as a real column is
  -- simpler than the AT TIME ZONE gymnastics that would make it immutable.
  hour_bucket      TIMESTAMPTZ NOT NULL,
  trophies         INTEGER NOT NULL,
  highest_trophies INTEGER,
  wins_3v3         INTEGER,
  wins_solo        INTEGER,
  wins_duo         INTEGER,
  brawler_count    INTEGER,
  exp_level        INTEGER
);

-- One snapshot per player per hour. A profile can be fetched many times a
-- minute; without this the table would grow by a row per refresh and the chart
-- would be a solid block of identical points.
CREATE UNIQUE INDEX IF NOT EXISTS player_snapshots_hourly_idx
  ON player_snapshots (tag, hour_bucket);

CREATE INDEX IF NOT EXISTS player_snapshots_tag_idx
  ON player_snapshots (tag, at DESC);

-- Tags discovered in battle logs, waiting to be crawled.
--
-- Separate from players_seen so the queue can be drained and refilled without
-- touching the record of who has been seen. A tag can be queued more than once
-- over time — after being crawled it goes back to the end of the line.
CREATE TABLE IF NOT EXISTS crawl_queue (
  tag           TEXT PRIMARY KEY,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Lower is sooner. Players met in many battles are worth crawling first:
  -- they play more, so their logs carry more fresh matches.
  priority      INTEGER NOT NULL DEFAULT 100,
  attempts      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS crawl_queue_order_idx
  ON crawl_queue (priority ASC, discovered_at ASC);
