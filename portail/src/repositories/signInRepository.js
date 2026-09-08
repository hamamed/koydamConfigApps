import { buildInsert } from '../db/sql.js'
import { nowIso } from '../utils/dates.js'

const TABLE = 'sign_ins'

/**
 * The sign-in log.
 *
 * Worth keeping because a shared login moves this evidence out of the services:
 * neither bdc nor marches ever sees a password now, so a run of failed attempts
 * against an account leaves no trace anywhere else.
 */
export function createSignInRepository(db) {
  async function add({ userId = null, email, outcome, service = null, ip = null, userAgent = null, createdAt = nowIso() }) {
    const { sql, params } = buildInsert(TABLE, {
      user_id: userId,
      email,
      outcome,
      service,
      ip,
      // Long enough to identify a browser, short enough not to store an essay.
      user_agent: userAgent ? String(userAgent).slice(0, 250) : null,
      created_at: createdAt,
    })
    return db.get(sql, params)
  }

  const recent = (limit = 50) =>
    db.all(`SELECT * FROM ${TABLE} ORDER BY created_at DESC, id DESC LIMIT ?`, [limit])

  const failuresSince = async (since) =>
    (await db.get(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE outcome = 'failed' AND created_at > ?`, [since]))?.n ?? 0

  return { add, recent, failuresSince }
}
