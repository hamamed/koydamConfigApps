import 'dotenv/config';

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

const bool = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
};

export const config = {
  env: process.env.NODE_ENV ?? 'production',
  port: int('PORT', 8090),
  // Loopback only — nginx terminates TLS and proxies here. Binding 0.0.0.0
  // would expose the admin panel without a certificate in front of it.
  host: process.env.HOST ?? '127.0.0.1',

  /**
   * Its own database on the Postgres server the other apps already use.
   *
   * Separate database rather than separate tables in one: a `DROP DATABASE` on
   * a mistake should not be able to take the crawler's corpus with it, and it
   * keeps backup and restore per-service.
   */
  postgresUrl: process.env.POSTGRES_URL ?? '',

  /**
   * Whether session cookies carry the Secure flag.
   *
   * Off until TLS is on: a Secure cookie is never sent over plain HTTP, so
   * enabling it early makes the dashboard impossible to log into on a box
   * that has not run certbot yet.
   */
  secureCookies: bool('SECURE_COOKIES', true),

  /**
   * Cookie domain, so one sign-in covers every subdomain.
   *
   * `.hamaprojects.com` makes the session cookie visible to config., api. and
   * skincraft. alike — which is what turns three logins into one. Leave blank
   * to scope the cookie to this host only, which is right for a single-service
   * install and wrong for this box.
   */
  cookieDomain: process.env.COOKIE_DOMAIN ?? '',

  /**
   * Shared secret the other services present when asking "who is this session".
   *
   * The session id alone would be enough to answer, but requiring a token as
   * well means a stolen cookie cannot be validated by anything that is not one
   * of our own services — and it keeps the endpoint from being a public oracle
   * for guessing session ids.
   */
  serviceToken: process.env.SERVICE_TOKEN ?? '',

  /**
   * Encrypts the secrets stored in the settings table.
   *
   * Stays in .env and nowhere else - it is the one thing a database dump must
   * not carry, since the dump is what gets copied offsite. Rotating it makes
   * every stored secret undecryptable, which reads as "unset" and falls back
   * to .env rather than breaking anything.
   */
  settingsKey: process.env.SETTINGS_KEY ?? '',

  /**
   * Hosts a post-login redirect may return to.
   *
   * An open redirect on a login page is a phishing primitive: sign in at the
   * real site, get bounced to an attacker's copy. Only these are accepted.
   */
  allowedRedirectHosts: (process.env.ALLOWED_REDIRECT_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),

  /**
   * First owner account, created on migrate when no users exist.
   *
   * Only ever used once — the check is "are there zero users", so it cannot
   * reset a live password or resurrect a deleted owner.
   */
  bootstrapEmail: process.env.BOOTSTRAP_EMAIL ?? '',
  bootstrapPassword: process.env.BOOTSTRAP_PASSWORD ?? '',


  /**
   * How long clients should cache a config response, in seconds.
   *
   * Sent as Cache-Control. Short enough that a kill switch takes effect within
   * minutes, long enough that a popular app is not asking on every cold start.
   */
  clientCacheSeconds: int('CLIENT_CACHE_SECONDS', 300),

  /** Records per-day fetch counts. No identifiers, just totals. */
  trackFetches: bool('TRACK_FETCHES', true),

  rateLimit: {
    windowMs: int('RATE_WINDOW_MS', 60_000),
    max: int('RATE_MAX', 600),
  },

  logLevel: process.env.LOG_LEVEL ?? 'info',
};
