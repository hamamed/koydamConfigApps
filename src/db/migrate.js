import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { log } from '../log.js';
import { getPool, isDbEnabled } from './pool.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, 'migrations');

/**
 * Applies every migration in filename order.
 *
 * The files are written to be idempotent (`IF NOT EXISTS` throughout), so this
 * runs on every boot and needs no versions table. That is a deliberate trade:
 * with a handful of files it removes an entire class of "the tracking table
 * disagrees with the database" bugs. It stops being the right call the moment a
 * migration has to *change* something rather than create it — at that point add
 * a schema_migrations table rather than making these files non-idempotent.
 *
 * Never throws: a failed migration logs and leaves the DB disabled rather than
 * blocking an API that mostly doesn't need it.
 */
export async function runMigrations() {
  if (!isDbEnabled()) {
    log.info('Postgres not configured — skipping migrations');
    return false;
  }

  const pool = getPool();
  if (!pool) return false;

  try {
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await pool.query(sql);
      log.debug('Migration applied', { file });
    }

    log.info('Postgres ready', { migrations: files.length });
    return true;
  } catch (err) {
    log.error('Migrations failed — database features disabled', {
      error: err.message,
    });
    return false;
  }
}
