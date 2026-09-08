import { getDb } from '../db/index.js'
import { buildInsert, buildUpdate } from '../db/sql.js'
import { nowIso } from '../utils/dates.js'

const TABLE = 'users'

/**
 * A bcrypt-shaped string no password hashes to. Stored for accounts that exist
 * here only because the portal vouched for them: they have no local password,
 * and a local sign-in attempt fails the comparison like any wrong one would.
 */
const SSO_ONLY_HASH = '$2a$12$ssoonlyssoonlyssoonlyssoonlyssoonlyssoonlyssoonlyssoonlyss'
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

  /**
   * The local row for somebody the portal has already authenticated.
   *
   * Identity is shared across the CivicTrust services; the databases are not.
   * Every foreign key here — favourites, invoices, saved searches — points at a
   * row in *this* schema, so a session arriving from the portal is resolved to
   * a local row by email address, created the first time it is seen.
   */
  async function ensureFromSso({ email, role = 'user', fullName = null }) {
    const address = String(email ?? '').toLowerCase().trim()
    if (!address) return null

    const existing = await findByEmail(address)
    if (existing) {
      // The portal is authoritative for role and name, so a change made there
      // arrives here on the next request rather than needing a second edit.
      const patch = {}
      if (role && existing.role !== role) patch.role = role
      if (fullName && existing.full_name !== fullName) patch.full_name = fullName
      return Object.keys(patch).length > 0 ? update(existing.id, patch) : existing
    }
    return create({ email: address, passwordHash: SSO_ONLY_HASH, fullName, role })
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

  return { ensureFromSso, findById, findByEmail, findByEmailWithSecret, touchPanel, listAll, create, touchLogin, update, remove, countAll, countByRole }
}
