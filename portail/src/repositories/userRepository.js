import { buildInsert, buildUpdate } from '../db/sql.js'
import { nowIso } from '../utils/dates.js'

const TABLE = 'users'

/**
 * The accounts every service on the domain signs in against.
 *
 * `password_hash` never leaves here except through `findByEmailWithSecret`,
 * whose name is the warning: everything else returns a row without it.
 */
export function createUserRepository(db) {
  const PUBLIC_COLUMNS = 'id, email, full_name, services, role, is_active, last_login_at, created_at, updated_at'

  const findById = (id) => db.get(`SELECT ${PUBLIC_COLUMNS} FROM ${TABLE} WHERE id = ?`, [id])
  const findByEmail = (email) => db.get(`SELECT ${PUBLIC_COLUMNS} FROM ${TABLE} WHERE email = ?`, [email])

  /** The only read that carries the hash. Used by login and by a password change. */
  const findByEmailWithSecret = (email) => db.get(`SELECT * FROM ${TABLE} WHERE email = ?`, [email])

  const listAll = () => db.all(`SELECT ${PUBLIC_COLUMNS} FROM ${TABLE} ORDER BY created_at DESC`)

  async function create({ email, passwordHash, fullName = null, role = 'user', services = 'bdc,marches' }) {
    const timestamp = nowIso()
    const { sql, params } = buildInsert(TABLE, {
      email,
      password_hash: passwordHash,
      full_name: fullName,
      services,
      role,
      created_at: timestamp,
      updated_at: timestamp,
    })
    return db.get(sql, params)
  }

  async function update(id, patch) {
    const { sql, params } = buildUpdate(TABLE, { ...patch, id, updated_at: nowIso() })
    return db.get(sql, params)
  }

  const touchLogin = (id) => db.run(`UPDATE ${TABLE} SET last_login_at = ? WHERE id = ?`, [nowIso(), id])
  const remove = (id) => db.run(`DELETE FROM ${TABLE} WHERE id = ?`, [id])
  const countAll = async () => (await db.get(`SELECT COUNT(*) AS n FROM ${TABLE}`))?.n ?? 0

  return { findById, findByEmail, findByEmailWithSecret, listAll, create, update, touchLogin, remove, countAll }
}
