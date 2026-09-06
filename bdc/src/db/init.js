import { getDb } from './index.js'
import { tableStatements, indexStatements, additiveColumns, SCHEMA_VERSION } from './schema.js'
import { nowIso } from '../utils/dates.js'
import { logger } from '../utils/logger.js'

const log = logger.child('[db:init]')

/**
 * The columns a table actually has, so an additive migration can tell whether it
 * still needs to run. SQLite has no `ADD COLUMN IF NOT EXISTS`, so the check is
 * required there and is done the same way on both engines.
 */
async function existingColumns(db, table) {
  const rows =
    db.dialect === 'postgres'
      ? await db.all('SELECT column_name AS name FROM information_schema.columns WHERE table_name = ?', [table])
      : await db.all(`PRAGMA table_info(${table})`)
  return new Set(rows.map((row) => row.name))
}

/**
 * Creates every table and index if missing, applies any additive column
 * migrations, then records the schema version.
 * Safe to call on every boot — every step is a no-op once applied.
 */
export async function initDatabase(db = getDb()) {
  const tables = tableStatements(db.dialect)
  const indexes = indexStatements()
  const added = []

  await db.transaction(async (tx) => {
    for (const statement of tables) {
      await tx.exec(statement)
    }

    // Columns before indexes: an index over a column added later cannot be
    // created until the ALTER that adds it has run.
    for (const { table, column, definition } of additiveColumns()) {
      if ((await existingColumns(tx, table)).has(column)) continue
      await tx.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
      added.push(`${table}.${column}`)
    }

    for (const statement of indexes) {
      await tx.exec(statement)
    }

    await tx.run(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?) ON CONFLICT (version) DO NOTHING',
      [SCHEMA_VERSION, nowIso()],
    )
  })

  log.info('schema ready', {
    dialect: db.dialect,
    version: SCHEMA_VERSION,
    statements: tables.length + indexes.length,
    ...(added.length > 0 ? { added } : {}),
  })
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
