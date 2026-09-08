import { config } from '../config/index.js'
import { createSqliteDriver } from './drivers/sqlite.js'
import { createPostgresDriver } from './drivers/postgres.js'

let driver = null

/**
 * Lazily creates the process-wide database driver.
 *
 * Both drivers expose the same surface — `all`, `get`, `run`, `exec`,
 * `transaction`, `close` — so repositories never branch on the dialect.
 */
export function getDb() {
  if (driver) return driver
  driver =
    config.db.client === 'postgres'
      ? createPostgresDriver({ connectionString: config.db.connectionString, ssl: config.db.ssl })
      : createSqliteDriver({ file: config.db.sqliteFile })
  return driver
}

/** Test seam: swaps in an in-memory or stub driver. */
export function setDb(customDriver) {
  driver = customDriver
}

export async function closeDb() {
  if (!driver) return
  await driver.close()
  driver = null
}
