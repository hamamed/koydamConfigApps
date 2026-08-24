/**
 * Applies the schema, then exits.
 *
 *   npm run db:migrate
 *
 * The server also migrates on boot, so this exists for the case where you want
 * to create the schema without starting the API — a first deploy, or checking
 * that POSTGRES_URL actually points somewhere before wiring it in.
 */
import { runMigrations } from '../db/migrate.js';
import { closePool, dbHealth } from '../db/pool.js';
import { log } from '../log.js';

const health = await dbHealth();
if (!health.enabled) {
  log.error('POSTGRES_URL is not set — nothing to migrate');
  process.exit(1);
}

const ok = await runMigrations();
await closePool();

if (!ok) {
  log.error('Migration failed');
  process.exit(1);
}

log.info('Schema is up to date');
