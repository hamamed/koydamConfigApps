import crypto from 'node:crypto'
import { getDb } from '../db/index.js'
import { buildInsert } from '../db/sql.js'
import { nowIso } from '../utils/dates.js'

const TABLE = 'password_resets'
const TOKEN_BYTES = 32
const LIFETIME_MINUTES = 60

/** The stored form of a reset token. Never the token itself. */
export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex')

export function createPasswordResetRepository(db = getDb()) {
  /**
   * Issues a token. The caller gets the raw value once, to put in a link; only
   * its hash is stored, so a database or backup copy cannot be used to log in.
   * @returns {Promise<{token: string, expiresAt: string}>}
   */
  async function issue(userId) {
    // Any earlier link stops working: requesting a new one should invalidate
    // whatever was sent before, including to an address no longer in reach.
    await db.run(`DELETE FROM ${TABLE} WHERE user_id = ? AND used_at IS NULL`, [userId])

    const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url')
    const expiresAt = new Date(Date.now() + LIFETIME_MINUTES * 60_000).toISOString()
    const { sql, params } = buildInsert(TABLE, {
      user_id: userId,
      token_hash: hashToken(token),
      expires_at: expiresAt,
      created_at: nowIso(),
    })
    await db.get(sql, params)
    return { token, expiresAt }
  }

  /** A token that exists, has not expired and has not been used. */
  const findUsable = (token) =>
    db.get(`SELECT * FROM ${TABLE} WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`, [
      hashToken(token),
      nowIso(),
    ])

  const consume = (id) => db.run(`UPDATE ${TABLE} SET used_at = ? WHERE id = ?`, [nowIso(), id])

  /** Housekeeping, so spent and expired tokens do not accumulate forever. */
  const purge = async () =>
    (await db.run(`DELETE FROM ${TABLE} WHERE expires_at < ? OR used_at IS NOT NULL`, [nowIso()])).changes

  return { issue, findUsable, consume, purge, LIFETIME_MINUTES }
}
