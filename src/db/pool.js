import pg from 'pg';

import { config } from '../config.js';
import { log } from '../log.js';

let pool = null;

export function isDbEnabled() {
  return Boolean(config.postgresUrl);
}

export function getPool() {
  if (!isDbEnabled()) return null;
  if (pool) return pool;

  pool = new pg.Pool({
    connectionString: config.postgresUrl,
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  // An idle client erroring is normal — Postgres closes connections. Logged
  // rather than thrown, because an unhandled 'error' event kills the process.
  pool.on('error', (err) => log.warn('Idle pg client error', { error: err.message }));
  return pool;
}

/**
 * Returns null on failure rather than throwing.
 *
 * Config serving must degrade, not fall over: a client that gets no response
 * has no ads and possibly no app, while one that gets a stale cached response
 * carries on. Callers treat null as "no data".
 */
export async function query(text, params = []) {
  const p = getPool();
  if (!p) return null;

  try {
    return await p.query(text, params);
  } catch (err) {
    log.error('Query failed', { error: err.message, sql: text.slice(0, 120) });
    return null;
  }
}

export async function dbHealth() {
  if (!isDbEnabled()) return { enabled: false, ok: false, reason: 'POSTGRES_URL not set' };
  const res = await query('SELECT 1 AS ok');
  return { enabled: true, ok: Boolean(res), reason: res ? null : 'query failed' };
}

export async function closePool() {
  if (pool) await pool.end();
  pool = null;
}
