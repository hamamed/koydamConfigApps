import { getDb } from '../db/index.js'
import { buildInsert } from '../db/sql.js'
import { nowIso } from '../utils/dates.js'

const TABLE = 'notifications'

/**
 * Every alert is recorded before it is delivered.
 *
 * That ordering matters: a mail server that is down, or absent entirely, must
 * not lose the alert. The row is the record; delivery is a status on it.
 */
export function createNotificationRepository(db = getDb()) {
  async function create(notification) {
    const { sql, params } = buildInsert(TABLE, {
      ...notification,
      status: 'pending',
      created_at: nowIso(),
    })
    return db.get(sql, params)
  }

  const markSent = (id) =>
    db.run(`UPDATE ${TABLE} SET status = 'sent', sent_at = ?, error_message = NULL WHERE id = ?`, [nowIso(), id])

  const markFailed = (id, message) =>
    db.run(`UPDATE ${TABLE} SET status = 'failed', error_message = ? WHERE id = ?`, [message, id])

  const listForUser = (userId, limit = 50) =>
    db.all(`SELECT * FROM ${TABLE} WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`, [userId, limit])

  const listPending = (limit = 100) =>
    db.all(`SELECT * FROM ${TABLE} WHERE status = 'pending' ORDER BY created_at LIMIT ?`, [limit])

  const countAll = async () => Number((await db.get(`SELECT COUNT(*) AS total FROM ${TABLE}`)).total)

  return { create, markSent, markFailed, listForUser, listPending, countAll }
}
