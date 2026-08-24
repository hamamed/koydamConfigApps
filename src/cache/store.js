import Redis from 'ioredis';

import { config } from '../config.js';
import { log } from '../log.js';

/**
 * Cache with a Redis backend and an in-memory fallback.
 *
 * Redis is preferred because it survives restarts and is shared across
 * processes — with PM2 running 2 workers, an in-memory cache means each worker
 * caches separately and you double your upstream calls. But requiring Redis to
 * boot would make first-time setup harder than it needs to be, so a single-node
 * deploy works without it.
 */

let redis = null;
/** @type {Map<string, {value: string, expiresAt: number}>} */
const memory = new Map();

if (config.redis.url) {
  redis = new Redis(config.redis.url, {
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    // Don't let a Redis outage take the API down — every call is wrapped and
    // degrades to the memory map.
    enableOfflineQueue: false,
  });

  redis.on('error', (err) => {
    log.warn('Redis error, falling back to memory cache', { error: err.message });
  });
  redis.on('connect', () => log.info('Redis connected'));
} else {
  log.warn('REDIS_URL not set — using in-memory cache (not shared across workers)');
}

const key = (k) => `${config.redis.prefix}${k}`;

/**
 * Evicts expired entries and caps the map.
 *
 * Without this the memory fallback is an unbounded leak: every unique tag ever
 * looked up would be retained for the life of the process.
 */
const MEMORY_MAX = 5_000;
function pruneMemory() {
  const now = Date.now();
  for (const [k, entry] of memory) {
    if (entry.expiresAt <= now) memory.delete(k);
  }
  if (memory.size > MEMORY_MAX) {
    // Map preserves insertion order, so the oldest keys come first.
    const excess = memory.size - MEMORY_MAX;
    let i = 0;
    for (const k of memory.keys()) {
      if (i++ >= excess) break;
      memory.delete(k);
    }
  }
}

export async function cacheGet(k) {
  const full = key(k);

  if (redis?.status === 'ready') {
    try {
      const raw = await redis.get(full);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      log.warn('Redis GET failed', { key: k, error: err.message });
    }
  }

  const entry = memory.get(full);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    memory.delete(full);
    return null;
  }
  return JSON.parse(entry.value);
}

export async function cacheSet(k, value, ttlSeconds) {
  const full = key(k);
  const raw = JSON.stringify(value);

  if (redis?.status === 'ready') {
    try {
      await redis.set(full, raw, 'EX', ttlSeconds);
      return;
    } catch (err) {
      log.warn('Redis SET failed', { key: k, error: err.message });
    }
  }

  memory.set(full, { value: raw, expiresAt: Date.now() + ttlSeconds * 1000 });
  if (memory.size % 100 === 0) pruneMemory();
}

export async function cacheDel(k) {
  const full = key(k);
  if (redis?.status === 'ready') {
    try {
      await redis.del(full);
    } catch {
      /* fall through to memory */
    }
  }
  memory.delete(full);
}

/**
 * Read-through cache wrapper.
 *
 * On an upstream failure with a usable stale copy, the stale copy wins. This is
 * the server-side half of the offline-first story: Supercell going down for
 * maintenance shouldn't blank out every client at once.
 */
export async function cached(k, ttlSeconds, producer, { staleOnError = true } = {}) {
  const hit = await cacheGet(k);
  if (hit !== null) return { data: hit, cached: true };

  try {
    const data = await producer();
    await cacheSet(k, data, ttlSeconds);

    if (staleOnError) {
      // A longer-lived shadow copy, used only when the producer fails later.
      await cacheSet(`stale:${k}`, data, Math.max(ttlSeconds * 20, 3_600));
    }

    return { data, cached: false };
  } catch (err) {
    if (staleOnError) {
      const stale = await cacheGet(`stale:${k}`);
      if (stale !== null) {
        log.warn('Serving stale cache after upstream failure', {
          key: k,
          error: err.message,
        });
        return { data: stale, cached: true, stale: true };
      }
    }
    throw err;
  }
}

export async function closeCache() {
  if (redis) await redis.quit().catch(() => {});
}

export function cacheStats() {
  return {
    backend: redis?.status === 'ready' ? 'redis' : 'memory',
    redisStatus: redis?.status ?? 'disabled',
    memoryEntries: memory.size,
  };
}
