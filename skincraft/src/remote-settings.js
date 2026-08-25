/**
 * Settings fetched from the panel, layered over .env.
 *
 * Copied into each service by the deploy overlay, so all of them read their
 * configuration the same way.
 *
 * ## The order, and why
 *
 *   1. a value set in the panel
 *   2. the .env value
 *   3. the code's own default
 *
 * .env stays as the floor rather than being replaced. A service must start and
 * keep running when the panel is unreachable - config being down is not a
 * reason for Brawl to stop answering - and on a first boot there is nothing in
 * the database yet.
 *
 * ## Refreshed on a timer, not per read
 *
 * Reads happen inside request handlers and the crawler loop; none of them can
 * afford a network call. The cache is refreshed every minute in the background
 * and every read is synchronous against whatever it last knew, which may be a
 * minute stale. That is the right trade for values like a cache lifetime or a
 * crawl interval, and it is why credentials the panel can change are still
 * read through this rather than captured at boot.
 */

const REFRESH_MS = 60_000;
const TIMEOUT_MS = 8_000;

let cache = {};
let lastFetch = 0;
let timer = null;
let started = false;

const PLATFORM_URL = () => (process.env.PLATFORM_URL ?? '').replace(/\/+$/, '');
const SERVICE_TOKEN = () => process.env.SERVICE_TOKEN ?? '';

/** Whether this service is able to ask at all. */
export function isRemoteConfigured() {
  return Boolean(PLATFORM_URL() && SERVICE_TOKEN());
}

async function fetchOnce(slug, log) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${PLATFORM_URL()}/api/services/${slug}/settings`, {
      signal: controller.signal,
      headers: { 'X-Service-Token': SERVICE_TOKEN() },
    });

    if (!res.ok) {
      log?.warn?.('Settings fetch failed', { status: res.status });
      return false;
    }

    const body = await res.json();
    if (body?.settings && typeof body.settings === 'object') {
      const before = JSON.stringify(cache);
      cache = body.settings;
      lastFetch = Date.now();

      if (JSON.stringify(cache) !== before) {
        // Logged by name only. The values include API keys.
        log?.info?.('Settings updated from the panel', {
          keys: Object.keys(cache).sort().join(','),
        });
      }
      return true;
    }

    return false;
  } catch (err) {
    // Unreachable, timed out, DNS. The existing cache stays in force, which is
    // the whole point of keeping one.
    log?.warn?.('Could not reach the settings service', { error: err.message });
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetches once, then keeps refreshing.
 *
 * Awaited at boot so the first request already has current values, but a
 * failure is not fatal: the service continues on .env alone.
 */
export async function startRemoteSettings(slug, log) {
  if (started) return;
  started = true;

  if (!isRemoteConfigured()) {
    log?.info?.('Panel settings not configured; using .env only');
    return;
  }

  await fetchOnce(slug, log);

  timer = setInterval(() => {
    fetchOnce(slug, log).catch(() => {});
  }, REFRESH_MS);

  // Must not hold the process open on shutdown.
  timer.unref?.();
}

export function stopRemoteSettings() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

/**
 * The value for a key, or undefined.
 *
 * Undefined rather than null so a caller can use `??` and have an explicitly
 * stored `null` behave differently from "not set here" - though nothing stores
 * null today, the distinction costs nothing and avoids a future puzzle.
 */
export function remote(key) {
  const v = cache[key];
  return v === undefined || v === null ? undefined : v;
}

/** For a health endpoint: is this service actually reading from the panel? */
export function remoteStatus() {
  return {
    configured: isRemoteConfigured(),
    keys: Object.keys(cache).length,
    lastFetch: lastFetch ? new Date(lastFetch).toISOString() : null,
    stale: lastFetch ? Date.now() - lastFetch > REFRESH_MS * 3 : true,
  };
}

// ── Typed readers ───────────────────────────────────────────────────────────
//
// Each takes the .env-derived fallback the service already computed, so a
// call site reads as "panel value, else what it used to do".

export function num(key, fallback) {
  const v = remote(key);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function bool(key, fallback) {
  const v = remote(key);
  if (v === undefined) return fallback;
  if (typeof v === 'boolean') return v;
  return String(v).toLowerCase() === 'true';
}

export function str(key, fallback) {
  const v = remote(key);
  if (v === undefined) return fallback;
  const s = String(v);
  return s.length ? s : fallback;
}
