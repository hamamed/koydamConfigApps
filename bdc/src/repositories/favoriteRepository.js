import { getDb } from '../db/index.js'
import { buildOrderBy, buildUpsert, buildWhere } from '../db/sql.js'
import { consultationClauses } from './filterClauses.js'
import { SORTABLE } from '../http/filters.js'
import { nowIso } from '../utils/dates.js'

const TABLE = 'favorites'

export function createFavoriteRepository(db = getDb()) {
  const find = (userId, reference) =>
    db.get(`SELECT * FROM ${TABLE} WHERE user_id = ? AND consultation_reference = ?`, [userId, reference])

  /** Idempotent: re-favouriting an entry just refreshes its note/tags. */
  async function add(userId, reference, { note = null, tags = null } = {}) {
    const timestamp = nowIso()
    const { sql, params } = buildUpsert(
      TABLE,
      {
        user_id: userId,
        consultation_reference: reference,
        note,
        tags,
        created_at: timestamp,
        updated_at: timestamp,
      },
      ['user_id', 'consultation_reference'],
      ['note', 'tags', 'updated_at'],
    )
    return db.get(sql, params)
  }

  const remove = async (userId, reference) =>
    (await db.run(`DELETE FROM ${TABLE} WHERE user_id = ? AND consultation_reference = ?`, [userId, reference])).changes

  /**
   * The Favorites tab payload: saved references joined to their consultation
   * and — when published — to the matching award, so a single request renders
   * the whole sub-tab.
   */
  async function listForUser(userId, filters = {}, { limit, offset, sort } = {}) {
    const where = buildWhere([['f.user_id = ?', userId], ...consultationClauses(filters, 'c')])
    const order = buildOrderBy(sort, SORTABLE.favorites, 'created_at').replace(
      /ORDER BY (\w+)/,
      (_, column) => `ORDER BY f.${column}`,
    )

    const rows = await db.all(
      `SELECT f.id AS favorite_id, f.note, f.tags, f.created_at AS favorited_at,
              c.*, r.attributaire, r.montant_attribue_cents, r.date_attribution, r.result_status
       FROM ${TABLE} f
       LEFT JOIN consultations c ON c.reference = f.consultation_reference
       LEFT JOIN consultation_results r ON r.reference = f.consultation_reference
       ${where.sql}${order} LIMIT ? OFFSET ?`,
      [...where.params, limit, offset],
    )

    const { total } = await db.get(
      `SELECT COUNT(*) AS total FROM ${TABLE} f LEFT JOIN consultations c ON c.reference = f.consultation_reference${where.sql}`,
      where.params,
    )
    return { rows, total: Number(total) }
  }

  /** References favourited by a user, used to decorate listing responses. */
  async function referencesForUser(userId) {
    const rows = await db.all(`SELECT consultation_reference FROM ${TABLE} WHERE user_id = ?`, [userId])
    return new Set(rows.map((row) => row.consultation_reference))
  }

  const countForUser = async (userId) =>
    Number((await db.get(`SELECT COUNT(*) AS total FROM ${TABLE} WHERE user_id = ?`, [userId])).total)

  return { find, add, remove, listForUser, referencesForUser, countForUser }
}
