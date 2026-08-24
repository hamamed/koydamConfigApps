import pg from 'pg';

import { config } from '../config.js';
import { log } from '../log.js';

/**
 * The Postgres connection pool.
 *
 * Postgres is the durable record; Redis stays the read cache in front of it.
 * They answer different questions — Redis makes "the current tier list" fast,
 * Postgres makes "how has Kit's win rate moved over six weeks" possible at all.
 * Neither replaces the other, and the crawl writes to both.
 *
 * Optional on purpose. The service ran on Redis alone before this existed, and
 * it still boots and serves every original endpoint without a database — only
 * the history and panel features degrade. A missing DB should not take an API
 * down that never needed one.
 */

let pool = null;
let unavailableReason = null;

export function isDbEnabled() {
  return Boolean(config.postgres.url);
}

/** Null when Postgres isn't configured. */
export function getPool() {
  if (!isDbEnabled()) return null;
  if (pool) return pool;

  pool = new pg.Pool({
    connectionString: config.postgres.url,
    max: config.postgres.poolSize,
    // A crawl inserts in bursts and then goes quiet for an hour; holding
    // connections open through that costs nothing on the app side and avoids a
    // reconnect storm at the top of each cycle.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  // A pool-level error is emitted for idle clients dropped by the server. Left
  // unhandled it takes the process down, which is a spectacular way to lose an
  // API over a database that is only used by two endpoints.
  pool.on('error', (err) => {
    log.error('Postgres pool error', { error: err.message });
  });

  return pool;
}

/**
 * Runs a query, or returns null when Postgres isn't available.
 *
 * Callers treat null as "no data" rather than as a failure, which is what keeps
 * the database optional.
 */
export async function query(text, params = []) {
  const p = getPool();
  if (!p) return null;

  try {
    return await p.query(text, params);
  } catch (err) {
    log.error('Query failed', { error: err.message, sql: text.slice(0, 120) });
    unavailableReason = err.message;
    return null;
  }
}

/** Runs `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction(fn) {
  const p = getPool();
  if (!p) return null;

  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    log.error('Transaction rolled back', { error: err.message });
    return null;
  } finally {
    client.release();
  }
}

export async function dbHealth() {
  if (!isDbEnabled()) {
    return { enabled: false, ok: false, reason: 'POSTGRES_URL not set' };
  }

  const res = await query('SELECT 1 AS ok');
  return {
    enabled: true,
    ok: Boolean(res),
    reason: res ? null : unavailableReason,
  };
}

export async function closePool() {
  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
  }
}
