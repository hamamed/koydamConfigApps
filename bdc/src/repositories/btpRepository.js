import { getDb } from '../db/index.js'
import { buildInsert, buildUpdate } from '../db/sql.js'
import { nowIso } from '../utils/dates.js'
import { matchName } from './exclusionRepository.js'

const TABLE = 'btp_companies'

/**
 * Qualified BTP companies, keyed the same way exclusions are.
 *
 * The name normalisation is shared with the exclusion register deliberately: a
 * company should be found under the same key wherever it appears, and the two
 * sources spell a business the same handful of ways.
 */
export function createBtpRepository(db = getDb()) {
  const findForCompany = (name) =>
    db.all(`SELECT * FROM ${TABLE} WHERE match_name = ? ORDER BY registre_commerce`, [matchName(name)])

  const countAll = async () => Number((await db.get(`SELECT COUNT(*) AS total FROM ${TABLE}`)).total)

  const listAll = (limit = 500) =>
    db.all(`SELECT * FROM ${TABLE} ORDER BY raison_sociale LIMIT ?`, [limit])

  /** The mutable facts. A company moves; its register number does not. */
  const MUTABLE = ['ville', 'adresse', 'telephone', 'fax', 'code', 'source_url']

  async function upsert(record) {
    const key = matchName(record.raison_sociale)
    const timestamp = nowIso()
    const existing = await db.get(
      `SELECT * FROM ${TABLE} WHERE registre_commerce = ? AND match_name = ?`,
      [record.registre_commerce, key],
    )

    if (!existing) {
      const { sql, params } = buildInsert(TABLE, {
        ...record,
        match_name: key,
        first_seen_at: timestamp,
        last_seen_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      })
      await db.run(sql, params)
      return { outcome: 'created' }
    }

    const changed = MUTABLE.some((column) => (record[column] ?? null) !== (existing[column] ?? null))
    const { sql, params } = buildUpdate(TABLE, {
      id: existing.id,
      ...Object.fromEntries(MUTABLE.map((column) => [column, record[column] ?? null])),
      last_seen_at: timestamp,
      ...(changed ? { updated_at: timestamp } : {}),
    })
    await db.run(sql, params)
    return { outcome: changed ? 'updated' : 'unchanged' }
  }

  return { findForCompany, listAll, countAll, upsert }
}
