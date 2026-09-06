import { getDb } from '../db/index.js'
import { nowIso } from '../utils/dates.js'

const TABLE = 'site_settings'

export function createSettingsRepository(db = getDb()) {
  const all = () => db.all(`SELECT key, value, updated_at, updated_by FROM ${TABLE}`)

  /** A null value means "reset": the row is removed so the fallback applies. */
  async function set(key, value, userId = null) {
    if (value === null) {
      await db.run(`DELETE FROM ${TABLE} WHERE key = ?`, [key])
      return
    }
    await db.run(
      `INSERT INTO ${TABLE} (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
                                       updated_by = excluded.updated_by`,
      [key, JSON.stringify(value), nowIso(), userId],
    )
  }

  return { all, set }
}
