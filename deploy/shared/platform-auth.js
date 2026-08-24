/**
 * Single sign-on client for the other panels on this box.
 *
 * Drop this file into a service, set three environment variables, and its
 * admin panel is protected by the same login as config.hamaprojects.com — no
 * password of its own, no key in a URL.
 *
 *   PLATFORM_URL=https://config.hamaprojects.com
 *   SERVICE_TOKEN=<same value as platform-api's SERVICE_TOKEN>
 *   PLATFORM_APP_SLUG=<the app this panel administers, e.g. brawl-stats>
 *
 * Usage:
 *
 *   import { requirePlatformAuth } from './platform-auth.js';
 *   router.use('/admin', requirePlatformAuth());
 *
 * ## How it works
 *
 * platform-api sets its session cookie on `.hamaprojects.com`, so the browser
 * already sends it here. A session id means nothing without the database
 * behind it, so this asks platform-api who it belongs to and caches the answer
 * briefly.
 *
 * ## Why not verify a signed token locally
 *
 * It would be faster and need no network call, but it could not be revoked:
 * disabling someone would leave them signed into this panel until their token
 * expired. One source of truth is worth a cached round trip.
 */

const COOKIE = 'platform_sid';

const PLATFORM_URL = (process.env.PLATFORM_URL ?? '').replace(/\/+$/, '');
const SERVICE_TOKEN = process.env.SERVICE_TOKEN ?? '';
const APP_SLUG = process.env.PLATFORM_APP_SLUG ?? '';

/**
 * How long an introspection result is trusted.
 *
 * The trade is revocation latency against traffic: at 60 seconds, disabling an
 * account takes effect within a minute and a busy panel makes one call a
 * minute per signed-in person rather than one per request.
 */
const CACHE_MS = 60_000;

/** Long enough for a slow round trip, short enough not to hang a page load. */
const TIMEOUT_MS = 5000;

const cache = new Map();

function readCookie(req, name) {
  const header = req.headers?.cookie ?? '';
  for (const pair of header.split(';')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    if (pair.slice(0, i).trim() === name) {
      return decodeURIComponent(pair.slice(i + 1).trim());
    }
  }
  return null;
}

/** Drops expired entries. Called opportunistically rather than on a timer. */
function sweep() {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expires <= now) cache.delete(key);
  }
}

/**
 * Asks platform-api who a session belongs to.
 *
 * Returns null on any failure — an unreachable identity provider must mean
 * "not signed in", never "signed in as nobody". Failing open here would make
 * every panel on the box world-writable the moment config went down.
 */
async function introspect(sid) {
  const hit = cache.get(sid);
  if (hit && hit.expires > Date.now()) return hit.user;

  if (!PLATFORM_URL || !SERVICE_TOKEN) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${PLATFORM_URL}/api/session/introspect`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Token': SERVICE_TOKEN,
      },
      body: JSON.stringify({ sid }),
    });

    if (!res.ok) return null;

    const body = await res.json();
    const user = body.active ? body.user : null;

    if (cache.size > 500) sweep();
    cache.set(sid, { user, expires: Date.now() + CACHE_MS });

    return user;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Whether this user may administer this service's app. */
function permitted(user) {
  if (!user) return false;
  if (user.role === 'owner' || user.role === 'admin') return true;
  if (!APP_SLUG) return false;
  // A viewer grant is read-only; these panels have no read-only mode, so only
  // an explicit app_admin grant opens them.
  return user.grants?.[APP_SLUG] === 'app_admin';
}

/**
 * Express middleware. Attaches `req.platformUser`, or bounces to the login.
 */
export function requirePlatformAuth() {
  return async (req, res, next) => {
    if (!PLATFORM_URL || !SERVICE_TOKEN) {
      // Misconfiguration must fail closed and say so — a panel that silently
      // let everyone in would be far worse than one that refuses to open.
      return res.status(503).send(
        'Single sign-on is not configured on this service. ' +
          'Set PLATFORM_URL and SERVICE_TOKEN.',
      );
    }

    const sid = readCookie(req, COOKIE);
    const user = sid ? await introspect(sid) : null;

    if (!user) {
      const back = encodeURIComponent(
        `${req.protocol}://${req.get('host')}${req.originalUrl}`,
      );
      return res.redirect(`${PLATFORM_URL}/login?next=${back}`);
    }

    if (!permitted(user)) {
      return res
        .status(403)
        .send(
          `Signed in as ${user.email}, but you do not have access to ` +
            `'${APP_SLUG}'. Ask an owner to grant it from the Team page.`,
        );
    }

    req.platformUser = user;
    next();
  };
}

/** Resolves the current user without enforcing anything. */
export async function platformUser(req) {
  const sid = readCookie(req, COOKIE);
  return sid ? introspect(sid) : null;
}
