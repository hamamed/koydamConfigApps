import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { logger } from '../../utils/logger.js'

const log = logger.child('[db:sqlite]')

/**
 * SQLite driver built on Node's bundled `node:sqlite` module — no native build
 * step, which keeps `npm install` reliable across Node versions.
 *
 * The underlying API is synchronous; every method is still declared async so the
 * PostgreSQL driver is a drop-in replacement.
 */
export function createSqliteDriver({ file }) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true })
  }

  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  log.info('connected', { file })

  let savepointDepth = 0

  /** node:sqlite only binds primitives — booleans and dates need coercing. */
  const bind = (params) =>
    params.map((value) => {
      if (typeof value === 'boolean') return value ? 1 : 0
      if (value instanceof Date) return value.toISOString()
      if (value === undefined) return null
      return value
    })

  const driver = {
    dialect: 'sqlite',

    async all(sql, params = []) {
      return db.prepare(sql).all(...bind(params))
    },

    async get(sql, params = []) {
      return db.prepare(sql).get(...bind(params))
    },

    async run(sql, params = []) {
      const result = db.prepare(sql).run(...bind(params))
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
    },

    async exec(sql) {
      db.exec(sql)
    },

    /** Nested calls use SAVEPOINTs so services can compose transactional units. */
    async transaction(handler) {
      const isNested = savepointDepth > 0
      const name = `sp_${savepointDepth}`
      db.exec(isNested ? `SAVEPOINT ${name}` : 'BEGIN')
      savepointDepth += 1
      try {
        const result = await handler(driver)
        db.exec(isNested ? `RELEASE ${name}` : 'COMMIT')
        return result
      } catch (error) {
        db.exec(isNested ? `ROLLBACK TO ${name}` : 'ROLLBACK')
        throw error
      } finally {
        savepointDepth -= 1
      }
    },

    async close() {
      db.close()
    },
  }

  return driver
}
