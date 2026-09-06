import { getDb } from '../db/index.js'
import { buildInsert } from '../db/sql.js'
import { nowIso } from '../utils/dates.js'

const TABLE = 'access_requests'

/** Requests for an account, from the public form. */
export function createAccessRequestRepository(db = getDb()) {
  const findById = (id) => db.get(`SELECT * FROM ${TABLE} WHERE id = ?`, [id])

  async function create(record) {
    const { sql, params } = buildInsert(TABLE, { ...record, status: 'pending', created_at: nowIso() })
    await db.run(sql, params)
    return db.get(`SELECT * FROM ${TABLE} WHERE email = ? ORDER BY id DESC LIMIT 1`, [record.email])
  }

  /**
   * Requests still waiting, oldest first — a queue is worked from the front,
   * and somebody who asked a week ago should not be behind this morning's.
   */
  const listPending = () =>
    db.all(`SELECT * FROM ${TABLE} WHERE status = 'pending' ORDER BY created_at ASC, id ASC`)

  const listRecent = (limit = 30) =>
    db.all(`SELECT * FROM ${TABLE} WHERE status <> 'pending' ORDER BY reviewed_at DESC, id DESC LIMIT ?`, [limit])

  const countPending = async () =>
    Number((await db.get(`SELECT COUNT(*) AS total FROM ${TABLE} WHERE status = 'pending'`)).total)

  /** An address that already has a request waiting does not get a second one. */
  const pendingForEmail = (email) =>
    db.get(`SELECT * FROM ${TABLE} WHERE email = ? AND status = 'pending'`, [email])

  /**
   * How many requests one address has sent since `since`. The rate limiter caps
   * a client by IP; this caps the address, because the interesting abuse is one
   * form submitted over and over from anywhere.
   */
  const countSince = async (email, since) =>
    Number((await db.get(`SELECT COUNT(*) AS total FROM ${TABLE} WHERE email = ? AND created_at >= ?`,
      [email, since])).total)

  async function review(id, { status, reviewNote, reviewedBy, userId = null }) {
    await db.run(
      `UPDATE ${TABLE} SET status = ?, review_note = ?, reviewed_at = ?, reviewed_by = ?, user_id = ?
       WHERE id = ?`,
      [status, reviewNote ?? null, nowIso(), reviewedBy ?? null, userId, id],
    )
    return findById(id)
  }

  return { create, findById, listPending, listRecent, countPending, pendingForEmail, countSince, review }
}
