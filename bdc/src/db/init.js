import { getDb } from './index.js'
import { tableStatements, indexStatements, SCHEMA_VERSION } from './schema.js'
import { nowIso } from '../utils/dates.js'
import { logger } from '../utils/logger.js'

const log = logger.child('[db:init]')

/**
 * Creates every table and index if missing, then records the schema version.
 * Safe to call on every boot — all statements are `IF NOT EXISTS`.
 */
export async function initDatabase(db = getDb()) {
  const statements = [...tableStatements(db.dialect), ...indexStatements()]

  await db.transaction(async (tx) => {
    for (const statement of statements) {
      await tx.exec(statement)
    }
    await tx.run(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?) ON CONFLICT (version) DO NOTHING',
      [SCHEMA_VERSION, nowIso()],
    )
  })

  log.info('schema ready', { dialect: db.dialect, version: SCHEMA_VERSION, statements: statements.length })
  return db
}

/** Drops every table — used by the test suite, never in production code paths. */
export async function dropDatabase(db = getDb()) {
  const tables = [
    'invoice_items',
    'invoices',
    'favorites',
    'result_lots',
    'consultation_results',
    'consultation_articles',
    'consultations',
    'scrape_jobs',
    'users',
    'schema_migrations',
  ]
  for (const table of tables) {
    await db.exec(`DROP TABLE IF EXISTS ${table}`)
  }
}
