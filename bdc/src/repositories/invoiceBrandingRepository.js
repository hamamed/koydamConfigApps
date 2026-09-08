import { nowIso } from '../utils/dates.js'

const TABLE = 'invoice_branding'

/** The columns a person may set. Anything else is not theirs to write. */
const FIELDS = Object.freeze([
  'template', 'font', 'accent', 'density', 'logo_data', 'logo_mime', 'logo_scale',
  'company_name', 'company_ice', 'company_address', 'company_email', 'company_phone', 'footer_note',
])

/**
 * How one person's invoices should look.
 *
 * A row is created on first save and updated afterwards, so a person who never
 * opens the screen has no row and gets the installation's defaults. Reads are
 * by user id only: branding is not shared, and there is no listing of it.
 */
export function createInvoiceBrandingRepository(db) {
  /** @returns {Promise<object|null>} the row, or null when never customised. */
  async function forUser(userId) {
    return (await db.get(`SELECT * FROM ${TABLE} WHERE user_id = ?`, [userId])) ?? null
  }

  /**
   * Writes the fields given and leaves the rest alone.
   * @param {number} userId whose branding this is.
   * @param {object} patch a subset of FIELDS.
   * @returns {Promise<object>} the row as it now stands.
   */
  async function save(userId, patch) {
    const entries = FIELDS.filter((field) => field in patch).map((field) => [field, patch[field]])
    const existing = await forUser(userId)
    const now = nowIso()

    if (!existing) {
      const columns = ['user_id', ...entries.map(([field]) => field), 'created_at', 'updated_at']
      const values = [userId, ...entries.map(([, value]) => value), now, now]
      await db.run(
        `INSERT INTO ${TABLE} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        values,
      )
      return forUser(userId)
    }

    if (entries.length === 0) return existing
    await db.run(
      `UPDATE ${TABLE} SET ${entries.map(([field]) => `${field} = ?`).join(', ')}, updated_at = ?
        WHERE user_id = ?`,
      [...entries.map(([, value]) => value), now, userId],
    )
    return forUser(userId)
  }

  /** Drops the logo without touching the rest of the branding. */
  async function clearLogo(userId) {
    await db.run(
      `UPDATE ${TABLE} SET logo_data = NULL, logo_mime = NULL, updated_at = ? WHERE user_id = ?`,
      [nowIso(), userId],
    )
    return forUser(userId)
  }

  return { forUser, save, clearLogo, FIELDS }
}
