import { getDb } from '../db/index.js'
import { buildInsert, buildUpdate } from '../db/sql.js'
import { nowIso } from '../utils/dates.js'

const TABLE = 'company_records'

/** Registry details recorded against a company name. */
export function createCompanyRecordRepository(db = getDb()) {
  const findByName = (name) => db.get(`SELECT * FROM ${TABLE} WHERE name = ?`, [name])

  const listVerified = (limit = 100) =>
    db.all(`SELECT * FROM ${TABLE} WHERE verified_at IS NOT NULL ORDER BY updated_at DESC LIMIT ?`, [limit])

  const countAll = async () => Number((await db.get(`SELECT COUNT(*) AS total FROM ${TABLE}`)).total)

  /** Insert or update by name — one row per company, always. */
  async function upsert(name, patch, { verifiedBy = null } = {}) {
    const existing = await findByName(name)
    const timestamp = nowIso()
    const fields = {
      ...patch,
      // A record only counts as verified when a person said so. A lookup that
      // filled the fields and was never reviewed stays unverified, and the
      // profile page labels it.
      verified_at: patch.verified_at === undefined ? (verifiedBy ? timestamp : existing?.verified_at ?? null) : patch.verified_at,
      verified_by: verifiedBy ?? existing?.verified_by ?? null,
      updated_at: timestamp,
    }

    if (!existing) {
      const { sql, params } = buildInsert(TABLE, { name, ...fields, created_at: timestamp })
      await db.run(sql, params)
      return findByName(name)
    }
    // buildUpdate takes the id *column* as its third argument and reads the
    // value out of the data — not a WHERE clause.
    const { sql, params } = buildUpdate(TABLE, { ...fields, id: existing.id })
    await db.run(sql, params)
    return findByName(name)
  }

  async function remove(name) {
    const existing = await findByName(name)
    if (!existing) return false
    await db.run(`DELETE FROM ${TABLE} WHERE id = ?`, [existing.id])
    return true
  }

  return { findByName, listVerified, countAll, upsert, remove }
}
