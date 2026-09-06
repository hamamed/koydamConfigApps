import pg from 'pg'
import { toPositionalPlaceholders } from '../sql.js'
import { logger } from '../../utils/logger.js'

const log = logger.child('[db:postgres]')

/**
 * PostgreSQL driver. Application SQL is written with `?` placeholders and
 * rewritten to `$n` here, so repositories stay dialect-agnostic.
 */
export function createPostgresDriver({ connectionString, ssl }) {
  const pool = new pg.Pool({
    connectionString,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30_000,
  })

  pool.on('error', (error) => log.error('idle client error', { message: error.message }))
  log.info('pool created')

  const executorFor = (client) => ({
    dialect: 'postgres',

    async all(sql, params = []) {
      const result = await client.query(toPositionalPlaceholders(sql), params)
      return result.rows
    },

    async get(sql, params = []) {
      const result = await client.query(toPositionalPlaceholders(sql), params)
      return result.rows[0]
    },

    async run(sql, params = []) {
      const result = await client.query(toPositionalPlaceholders(sql), params)
      return { changes: result.rowCount ?? 0, lastInsertRowid: result.rows[0]?.id ?? null }
    },

    async exec(sql) {
      await client.query(sql)
    },
  })

  const driver = {
    ...executorFor(pool),

    async transaction(handler) {
      const client = await pool.connect()
      const scoped = executorFor(client)
      scoped.transaction = async (nested) => nested(scoped)
      try {
        await client.query('BEGIN')
        const result = await handler(scoped)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },

    async close() {
      await pool.end()
    },
  }

  return driver
}
