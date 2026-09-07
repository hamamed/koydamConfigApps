import { getDb } from '../db/index.js'
import { buildInsert, buildUpdate } from '../db/sql.js'
import { nowIso } from '../utils/dates.js'

const TABLE = 'saved_searches'

export function createSavedSearchRepository(db = getDb()) {
  const findById = (id) => db.get(`SELECT * FROM ${TABLE} WHERE id = ?`, [id])

  const listForUser = (userId) =>
    db.all(`SELECT * FROM ${TABLE} WHERE user_id = ? ORDER BY created_at DESC`, [userId])

  /** Active searches with their owner's address, for the digest run. */
  const listActive = () =>
    db.all(
      `SELECT s.*, u.email, u.full_name FROM ${TABLE} s
       JOIN users u ON u.id = s.user_id
       WHERE s.is_active = 1 AND u.is_active = 1
       ORDER BY s.user_id, s.id`,
    )

  async function create({ userId, name, filters, notifyNew = true, notifyAwards = false }) {
    const timestamp = nowIso()
    const { sql, params } = buildInsert(TABLE, {
      user_id: userId,
      name,
      filters_json: JSON.stringify(filters ?? {}),
      notify_new: notifyNew ? 1 : 0,
      notify_awards: notifyAwards ? 1 : 0,
      is_active: 1,
      // Start from now: a new search should not fire a digest about the whole
      // back catalogue on the day it is created.
      last_seen_cursor: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    })
    return db.get(sql, params)
  }

  async function update(id, patch) {
    const statement = buildUpdate(TABLE, { ...patch, id, updated_at: nowIso() })
    if (!statement) return findById(id)
    return db.get(statement.sql, statement.params)
  }

  const remove = async (id, userId) =>
    (await db.run(`DELETE FROM ${TABLE} WHERE id = ? AND user_id = ?`, [id, userId])).changes

  const countForUser = async (userId) =>
    Number((await db.get(`SELECT COUNT(*) AS total FROM ${TABLE} WHERE user_id = ?`, [userId])).total)

  return { findById, listForUser, listActive, create, update, remove, countForUser }
}
