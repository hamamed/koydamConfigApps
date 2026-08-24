import 'dotenv/config';

/**
 * Fails fast on missing required config rather than 500ing on the first
 * request. A container that won't start is a much clearer signal than one that
 * starts and returns errors.
 */
function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: int('PORT', 8080),

  /**
   * Bind host. Behind nginx, 127.0.0.1 keeps the app off the public interface
   * so the only way in is through the reverse proxy (and its TLS + rate limits).
   * Docker needs 0.0.0.0 because the container's loopback isn't reachable from
   * the host.
   */
  host: process.env.HOST ?? '127.0.0.1',

  supercell: {
    /**
     * From developer.brawlstars.com. The token is IP-locked — it must be
     * created with this VPS's public IPv4 address, which is the entire reason
     * this service exists instead of the app calling Supercell directly.
     */
    token: required('BRAWL_API_TOKEN'),
    baseUrl: process.env.BRAWL_API_BASE ?? 'https://api.brawlstars.com/v1',
    timeoutMs: int('SUPERCELL_TIMEOUT_MS', 10_000),
    retries: int('SUPERCELL_RETRIES', 2),
  },

  /**
   * Optional shared secret. When set, every request must carry
   * `Authorization: Bearer <key>`. Matches BRAWL_API_KEY in the Flutter client.
   * Left empty the API is public — fine while you're the only user, worth
   * setting before you ship.
   */
  apiKey: process.env.PUBLIC_API_KEY ?? '',

  redis: {
    url: process.env.REDIS_URL ?? '',
    /** Key prefix so this app can share a Redis instance with others. */
    prefix: process.env.REDIS_PREFIX ?? 'bs:',
  },

  /**
   * Server-side TTLs in seconds.
   *
   * These are deliberately SHORTER than the Flutter client's TTLs. The client
   * caches to avoid network calls; the server caches to avoid burning
   * Supercell's rate limit. Supercell's own data only updates when a battle
   * ends, so caching a player for 60s costs freshness almost nothing and cuts
   * upstream calls hard when several people look up the same popular tag.
   */
  ttl: {
    player: int('TTL_PLAYER', 60),
    battleLog: int('TTL_BATTLELOG', 60),
    club: int('TTL_CLUB', 300),

    /** Leaderboards move slowly and are expensive upstream. */
    rankings: int('TTL_RANKINGS', 600),

    /** Up to 30 upstream calls per response — cached hard on purpose. */
    clubActivity: int('TTL_CLUB_ACTIVITY', 1800),
    brawlers: int('TTL_BRAWLERS', 86_400),
    events: int('TTL_EVENTS', 900),
    meta: int('TTL_META', 3_600),
    /** Negative caching: stops a bad tag being retried against Supercell. */
    notFound: int('TTL_NOT_FOUND', 120),
  },

  rateLimit: {
    windowMs: int('RATE_WINDOW_MS', 60_000),
    max: int('RATE_MAX', 120),
  },

  analytics: {
    /**
     * Which record the meta analytics read.
     *
     * `auto`     — use the per-player tables once they hold enough recent data,
     *              otherwise the legacy battle_samples. This is the migration
     *              path: no screen goes empty while the new model fills.
     * `battles`  — force the per-player model, even if it is empty.
     * `samples`  — force the legacy table, e.g. to compare the two.
     */
    source: (process.env.ANALYTICS_SOURCE ?? 'auto').toLowerCase(),

    /**
     * Whether to keep writing the legacy `battle_samples` table.
     *
     * Both records are written during the migration so the fallback above has
     * something to fall back to. Once the panel reports `battle_players` as the
     * live source and you are satisfied with it, turning this off halves the
     * crawler's write volume and lets retention reclaim the old table.
     *
     * Turning it off is one-way in practice: the legacy table stops growing and
     * ages out, so the automatic fallback has nothing left to serve.
     */
    writeLegacySamples: bool('WRITE_LEGACY_SAMPLES', true),
  },

  wallpapers: {
    /**
     * Folder of wallpaper images served to the app.
     *
     * Relative paths resolve against the working directory, which for the
     * systemd unit is the install root — so the default lands at
     * `/opt/brawl-vps/wallpapers`. Deliberately *outside* the deploy archive:
     * `tar x` only overwrites what it contains, so uploads survive an update
     * and nobody has to re-upload their gallery to ship a code change.
     *
     * Subfolders become categories. One level deep only.
     */
    dir: process.env.WALLPAPER_DIR ?? 'wallpapers',

    /**
     * How long a directory listing is cached.
     *
     * Short: the whole point is that dropping a file into the folder makes it
     * appear, and a long TTL turns that into "appears eventually". Scanning a
     * few hundred files is cheap enough that this is mostly about not doing it
     * once per grid scroll.
     */
    ttl: int('TTL_WALLPAPERS', 120),
  },

  crawler: {
    enabled: bool('CRAWLER_ENABLED', true),
    /** How often to rebuild the tier list, in minutes. */
    intervalMinutes: int('CRAWLER_INTERVAL_MIN', 60),
    /**
     * Countries to sample top players from. 'global' is the widest net;
     * add regions if you want the meta weighted toward a specific server.
     */
    regions: (process.env.CRAWLER_REGIONS ?? 'global').split(','),
    /**
     * Top-N players sampled per region. Each player costs one battlelog
     * request, so this is the main dial on crawl cost: 200 players ≈ 200
     * upstream calls per cycle.
     */
    playersPerRegion: int('CRAWLER_PLAYERS', 200),
    /** Concurrent battlelog fetches. Keep modest to stay under rate limits. */
    concurrency: int('CRAWLER_CONCURRENCY', 4),
    /**
     * Minimum appearances before a brawler is ranked in a bucket. Without a
     * floor, one player going 1-0 on an off-meta brawler tops the tier list.
     */
    minSampleSize: int('CRAWLER_MIN_SAMPLE', 20),

    /**
     * Players pulled from the discovery queue each cycle.
     *
     * The rankings return the same top 200 every hour, and those players do not
     * produce 25 fresh matches in that time — one observed cycle added 30,000
     * new battles, the next added 567. Growth comes from widening the frontier
     * instead: every battle log names up to ~150 other players, each with a log
     * of their own.
     *
     * This is the main upstream-cost dial. Total requests per cycle are roughly
     * CRAWLER_PLAYERS + CRAWLER_DISCOVERY + CRAWLER_SEARCHED. Set to 0 to go
     * back to rankings-only crawling.
     */
    discoveryPerCycle: int('CRAWLER_DISCOVERY', 150),

    /**
     * Searched players refreshed each cycle.
     *
     * Anyone a human looked up in the app, least-recently-crawled first. These
     * are the players someone actually cares about, so their history stays
     * dense even when they are nowhere near the top of the ladder.
     */
    searchedPerCycle: int('CRAWLER_SEARCHED', 50),

    /**
     * Full player profiles refreshed each cycle.
     *
     * A battle log says what someone played; only `/players/{tag}` says who
     * they are — trophies, roster, club. That is a second upstream request per
     * player, so it is spent on ranked and searched players only, rotated
     * oldest-first so the per-cycle cost stays flat as the population grows.
     *
     * Counts toward the cycle's request budget alongside CRAWLER_PLAYERS,
     * CRAWLER_DISCOVERY and CRAWLER_SEARCHED. 0 disables profile refreshing,
     * which leaves personal stats and the trophy percentile without a source.
     */
    profilesPerCycle: int('CRAWLER_PROFILES', 40),
  },

  brawlerMeta: {
    /**
     * Community metadata source for rarity, class and portraits — none of which
     * the official API returns. Public, unauthenticated.
     *
     * Note this is `brawlapi.com`, not `brawlify.com`. The latter sits behind a
     * CDN that returns 403 to non-browser clients (verified during setup), so it
     * would fail on a VPS. This host serves the same payload without blocking.
     *
     * Hypercharge is NOT here — no free API exposes it. See
     * data/hypercharge-overrides.json.
     */
    sourceUrl:
      process.env.BRAWLER_META_URL ?? 'https://api.brawlapi.com/v1/brawlers',
    /** Refresh cadence in hours. Only changes when a brawler is released. */
    refreshHours: int('BRAWLER_META_REFRESH_H', 24),
  },

  /**
   * Durable storage for crawl output.
   *
   * Optional. Without POSTGRES_URL the service behaves exactly as it did before
   * a database existed — Redis still caches, the tier list still serves — and
   * only the history endpoints and the admin panel go quiet. That is deliberate:
   * a database outage should not take down an API that ran without one for
   * months.
   */
  postgres: {
    url: process.env.POSTGRES_URL ?? '',
    poolSize: int('POSTGRES_POOL', 8),
    /**
     * How long raw sampled battles are kept.
     *
     * A year by default. Be aware of what that costs: raw rows are ~200 bytes
     * with their indexes, and a discovery crawl can add tens of thousands an
     * hour. At 50k/day that is ~18M rows and roughly 4GB a year; with an
     * aggressive CRAWLER_DISCOVERY it can be several times that.
     *
     * The aggregates in brawler_stats — what every chart actually reads — are
     * tiny and are never pruned, so lowering this loses the ability to ask new
     * questions about old matches, not any existing feature. Watch the sizes in
     * the admin panel and turn it down if the disk gets tight.
     */
    retentionDays: int('POSTGRES_RETENTION_DAYS', 365),

    /**
     * How long per-player battles are kept, in days.
     *
     * Separate from `retentionDays`, which governs the legacy `battle_samples`
     * table. These are the rows that know *who* played, and they are the ones
     * personal stats accumulate from — so they get a longer window and their
     * own dial.
     *
     * Measured cost: ~360k participant rows a day at a 60-minute crawl, around
     * 420 bytes each with indexes. Six months lands near 29GB; doubling the
     * crawl rate doubles that. See `POSTGRES_DISK_BUDGET_GB`.
     */
    battleRetentionDays: int('POSTGRES_BATTLE_RETENTION_DAYS', 180),

    /**
     * Ceiling on the combined size of `battles` + `battle_players`, in bytes.
     *
     * Retention is expressed in days, but disks are measured in bytes, and the
     * conversion between them is the crawl rate — a config value that can be
     * raised without anyone recomputing what it costs. When the tables exceed
     * this, the crawler shortens the effective window and says so in the log.
     *
     * A Postgres that fills its disk stops accepting writes and is unpleasant
     * to recover, so this exists to make that unreachable. 0 disables it.
     */
    diskBudgetBytes: int('POSTGRES_DISK_BUDGET_GB', 40) * 1_000_000_000,
  },

  /**
   * Guards the admin panel and its endpoints.
   *
   * Empty disables the panel entirely rather than leaving it open — an
   * unauthenticated dashboard exposing crawl internals is worse than no
   * dashboard, and defaulting to "off" means forgetting to set this fails safe.
   */
  adminKey: process.env.ADMIN_KEY ?? '',

  logLevel: process.env.LOG_LEVEL ?? 'info',
};
