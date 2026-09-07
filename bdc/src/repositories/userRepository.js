import { getDb } from '../db/index.js'
import { buildInsert, buildUpdate } from '../db/sql.js'
import { nowIso } from '../utils/dates.js'

const TABLE = 'users'
const PUBLIC_COLUMNS = 'id, email, full_name, role, is_active, last_login_at, created_at, updated_at'

export function createUserRepository(db = getDb()) {
  /** Includes `password_hash` — only for the auth service. */
  const findByEmailWithSecret = (email) =>
    db.get(`SELECT * FROM ${TABLE} WHERE email = ?`, [String(email).toLowerCase().trim()])

  /** Existence and display, without the hash. Anything that is not signing
   *  somebody in wants this one. */
  const findByEmail = (email) =>
    db.get(`SELECT ${PUBLIC_COLUMNS} FROM ${TABLE} WHERE email = ?`, [String(email).toLowerCase().trim()])

  const findById = (id) => db.get(`SELECT ${PUBLIC_COLUMNS} FROM ${TABLE} WHERE id = ?`, [id])

  const listAll = () => db.all(`SELECT ${PUBLIC_COLUMNS} FROM ${TABLE} ORDER BY created_at DESC`)

  async function create({ email, passwordHash, fullName = null, role = 'user' }) {
    const timestamp = nowIso()
    const { sql, params } = buildInsert(TABLE, {
      email: String(email).toLowerCase().trim(),
      password_hash: passwordHash,
      full_name: fullName,
      role,
      is_active: 1,
      created_at: timestamp,
      updated_at: timestamp,
    })
    const row = await db.get(sql, params)
    return findById(row.id)
  }

  const touchLogin = (id) =>
    db.run(`UPDATE ${TABLE} SET last_login_at = ?, updated_at = ? WHERE id = ?`, [nowIso(), nowIso(), id])

  async function update(id, patch) {
    const statement = buildUpdate(TABLE, { ...patch, id, updated_at: nowIso() })
    if (!statement) return findById(id)
    await db.get(statement.sql, statement.params)
    return findById(id)
  }

  const countAll = async () => Number((await db.get(`SELECT COUNT(*) AS total FROM ${TABLE}`)).total)

  const remove = (id) => db.run(`DELETE FROM ${TABLE} WHERE id = ?`, [id])

  const countByRole = async (role) =>
    Number((await db.get(`SELECT COUNT(*) AS total FROM ${TABLE} WHERE role = ? AND is_active = 1`, [role])).total)

  /**
   * Records that this user has just looked, and answers with when they looked
   * before. Read-then-write in one call because every caller wants both, and
   * doing it in two invites the window where a page load moves the mark before
   * the page has used it.
   */
  async function touchPanel(id, at = nowIso()) {
    const before = (await db.get(`SELECT last_panel_at FROM ${TABLE} WHERE id = ?`, [id]))?.last_panel_at ?? null
    await db.run(`UPDATE ${TABLE} SET last_panel_at = ? WHERE id = ?`, [at, id])
    return before
  }

  return { findById, findByEmail, findByEmailWithSecret, touchPanel, listAll, create, touchLogin, update, remove, countAll, countByRole }
}
