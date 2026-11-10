import { cacheGet, cacheSet } from '../cache/store.js';

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

/**
 * Serves a cached value, building it on a miss. Concurrent misses share one
 * build; a request waits up to `waitMs`, then gets null (the caller answers
 * "building") while the build carries on and fills the cache.
 */
const inflight = new Map();
export async function cachedOrBuilding(key, ttlSeconds, build, waitMs = 14_000) {
  const hit = await cacheGet(key);
  if (hit !== null) return hit;
  let job = inflight.get(key);
  if (!job) {
    job = (async () => {
      try {
        const value = await build();
        await cacheSet(key, value, ttlSeconds);
        return value;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, job);
  }
  return Promise.race([job, new Promise((r) => setTimeout(() => r(null), waitMs).unref?.())]);
}
