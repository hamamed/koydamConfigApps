import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPool, isDbEnabled } from './pool.js';
import { log } from '../log.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'migrations');

/**
 * Runs every .sql file in order, every boot.
 *
 * No schema_migrations table: each file is written to be idempotent
 * (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), which is simpler to reason
 * about than a ledger that can disagree with the database it describes.
 */
export async function runMigrations() {
  if (!isDbEnabled()) {
    log.warn('POSTGRES_URL not set — refusing to start without a database');
    return false;
  }

  const pool = getPool();
  const files = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = await readFile(path.join(DIR, file), 'utf8');
    try {
      await pool.query(sql);
    } catch (err) {
      log.error('Migration failed', { file, error: err.message });
      throw err;
    }
  }

  log.info('Schema ready', { migrations: files.length });
  return true;
}

// `npm run migrate`
if (process.argv[1] && process.argv[1].endsWith('migrate.js')) {
  runMigrations()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
