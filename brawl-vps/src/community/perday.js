import { cacheGet, cacheSet } from '../cache/store.js';
import { log } from '../log.js';

/**
 * Raw-battle scans one UTC day at a time, with settled days cached.
 *
 * Days at least two days old are cached for eight days; today and yesterday
 * are always re-read, since battle logs fetched hours later still add battles
 * to them. Days run one after another to keep the database responsive.
 */

export const DAY = 86_400_000;
export const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The last `n` UTC days ending at `endMs` (a midnight), oldest first. */
export const daysBack = (endMs, n) => Array.from({ length: n }, (_, i) => isoDay(endMs - (n - 1 - i) * DAY));

/** Midnight UTC of `now`, in ms. */
export const utcMidnight = (now = new Date()) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

/** Runs `fn(start, end)` per day; returns `[{ day, value }]` in day order. */
export async function perDay(name, days, todayIso, fn) {
  const settled = isoDay(Date.parse(`${todayIso}T00:00:00Z`) - DAY);
  const out = [];
  for (const day of days) {
    const start = new Date(`${day}T00:00:00Z`);
    const end = new Date(start.getTime() + DAY);
    const key = `community:day:${name}:${day}`;
    const cacheable = day < settled;
    const hit = cacheable ? await cacheGet(key) : null;
    if (hit !== null) {
      out.push({ day, value: hit });
      continue;
    }
    const value = await fn(start, end);
    if (cacheable) await cacheSet(key, value, 8 * 86_400);
    out.push({ day, value });
  }
  return out;
}

/** Sums per-day row lists by `keyOf`, adding the numeric fields in `fields`. */
export function merge(perDayRows, keyOf, fields) {
  const out = new Map();
  for (const { value } of perDayRows) {
    for (const row of value) {
      const key = keyOf(row);
      const acc = out.get(key) ?? { ...row, ...Object.fromEntries(fields.map((f) => [f, 0])) };
      for (const f of fields) acc[f] += row[f];
      out.set(key, acc);
    }
  }
  return [...out.values()];
}

/** How long the last good copy of a cached build is kept behind the fresh one. */
const STALE_SECONDS = 3 * 86_400;

const inflight = new Map();

/** Starts (or joins) the one build for `key`; it fills the fresh and the stale copy. */
function startBuild(key, ttlSeconds, build) {
  let job = inflight.get(key);
  if (!job) {
    job = (async () => {
      try {
        const value = await build();
        await cacheSet(key, value, ttlSeconds);
        await cacheSet(`stale:${key}`, value, Math.max(STALE_SECONDS, ttlSeconds));
        return value;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, job);
  }
  return job;
}

/**
 * Serves a cached value, building it on a miss. Concurrent misses share one
 * build.
 *
 * When the fresh copy has expired but an earlier build is still on hand (kept
 * for three days), that copy is answered at once and the rebuild runs behind
 * it, so a page someone opened before never waits on the database again.
 * Only a key that was never built waits, up to `waitMs`, then gets null (the
 * caller answers "building") while the build carries on and fills the cache.
 */
export async function cachedOrBuilding(key, ttlSeconds, build, waitMs = 14_000) {
  const hit = await cacheGet(key);
  if (hit !== null) return hit;
  const stale = await cacheGet(`stale:${key}`);
  const job = startBuild(key, ttlSeconds, build);
  if (stale !== null) {
    job.catch((err) => log.warn('Background rebuild failed; serving the last good copy', { key, error: err.message }));
    return stale;
  }
  return Promise.race([job, new Promise((r) => setTimeout(() => r(null), waitMs).unref?.())]);
}

/** A cached value every caller waits for, built once however many ask at the same time. */
export async function cachedShared(key, ttlSeconds, build) {
  const hit = await cacheGet(key);
  if (hit !== null) return hit;
  return startBuild(key, ttlSeconds, build);
}
