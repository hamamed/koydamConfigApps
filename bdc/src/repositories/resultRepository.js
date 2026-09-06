import { getDb } from '../db/index.js'
import { buildInsert, buildOrderBy, buildUpdate, buildUpsert, buildWhere } from '../db/sql.js'
import { resultClauses } from './filterClauses.js'
import { RESULT_HASH_COLUMNS, hashColumns, mergeScraped } from './scrapedRecord.js'
import { SORTABLE } from '../http/filters.js'
import { nowIso } from '../utils/dates.js'

const TABLE = 'consultation_results'
const LOTS_TABLE = 'result_lots'

const MUTABLE_COLUMNS = [
  'reference_raw', 'objet', 'acheteur', 'categorie', 'nature_prestation', 'lieu_execution',
  'procedure_type', 'date_publication_resultat', 'date_attribution', 'attributaire',
  'attributaire_ice', 'montant_attribue_cents', 'currency', 'nombre_offres', 'result_status',
  'detail_url', 'source_url', 'search_text', 'raw_json', 'last_seen_at', 'updated_at',
]

export function createResultRepository(db = getDb()) {
  const findById = (id) => db.get(`SELECT * FROM ${TABLE} WHERE id = ?`, [id])

  const findByReference = (reference) => db.get(`SELECT * FROM ${TABLE} WHERE reference = ?`, [reference])

  const findLots = (resultId) =>
    db.all(`SELECT * FROM ${LOTS_TABLE} WHERE result_id = ? ORDER BY lot_number, id`, [resultId])

  /**
   * Inserts or refreshes a scraped award, keyed on `reference` — the same key the
   * consultations table uses, which is what makes the two datasets joinable.
   * @returns {Promise<{row: object, outcome: 'created'|'updated'|'unchanged'}>}
   */
  async function upsert(record) {
    const existing = await findByReference(record.reference)
    const timestamp = nowIso()

    if (!existing) {
      const { sql, params } = buildInsert(TABLE, {
        ...record,
        content_hash: hashColumns(record, RESULT_HASH_COLUMNS),
      })
      return { row: await db.get(sql, params), outcome: 'created' }
    }

    const merged = mergeScraped(existing, record, MUTABLE_COLUMNS)
    merged.content_hash = hashColumns(merged, RESULT_HASH_COLUMNS)

    if (existing.content_hash === merged.content_hash) {
      await db.run(`UPDATE ${TABLE} SET last_seen_at = ? WHERE id = ?`, [timestamp, existing.id])
      return { row: existing, outcome: 'unchanged' }
    }

    const update = buildUpdate(TABLE, { ...merged, id: existing.id, last_seen_at: timestamp, updated_at: timestamp })
    return { row: await db.get(update.sql, update.params), outcome: 'updated' }
  }

  async function replaceLots(resultId, reference, lots) {
    return db.transaction(async (tx) => {
      await tx.run(`DELETE FROM ${LOTS_TABLE} WHERE result_id = ?`, [resultId])
      const inserted = []
      for (const lot of lots) {
        const { sql, params } = buildUpsert(
          LOTS_TABLE,
          { ...lot, result_id: resultId, consultation_reference: reference },
          ['result_id', 'lot_number'],
        )
        const row = await tx.get(sql, params)
        if (row) inserted.push(row)
      }
      return inserted
    })
  }

  async function search(filters = {}, { limit, offset, sort } = {}) {
    const where = buildWhere(resultClauses(filters, 'r'))
    const order = buildOrderBy(sort, SORTABLE.results, 'date_publication_resultat')
    const rows = await db.all(
      `SELECT r.*, c.id AS consultation_row_id, c.objet AS consultation_objet, c.date_limite
       FROM ${TABLE} r
       LEFT JOIN consultations c ON c.reference = r.reference
       ${where.sql}${order} LIMIT ? OFFSET ?`,
      [...where.params, limit, offset],
    )
    const { total } = await db.get(`SELECT COUNT(*) AS total FROM ${TABLE} r${where.sql}`, where.params)
    return { rows, total: Number(total) }
  }

  /** Links every result to its consultation via the shared `reference` key. */
  async function linkUnmatched() {
    const result = await db.run(
      `UPDATE ${TABLE} SET consultation_id = (SELECT c.id FROM consultations c WHERE c.reference = ${TABLE}.reference),
              matched_at = ?
       WHERE consultation_id IS NULL
         AND EXISTS (SELECT 1 FROM consultations c WHERE c.reference = ${TABLE}.reference)`,
      [nowIso()],
    )
    return result.changes
  }

  const countAll = async () => Number((await db.get(`SELECT COUNT(*) AS total FROM ${TABLE}`)).total)

  const countUnmatched = async () =>
    Number((await db.get(`SELECT COUNT(*) AS total FROM ${TABLE} WHERE consultation_id IS NULL`)).total)

  async function update(id, patch) {
    const statement = buildUpdate(TABLE, { ...patch, id, updated_at: nowIso() })
    if (!statement) return findById(id)
    return db.get(statement.sql, statement.params)
  }

  const remove = (id) => db.run(`DELETE FROM ${TABLE} WHERE id = ?`, [id])

  return { findById, findByReference, findLots, upsert, replaceLots, search, linkUnmatched, countAll, countUnmatched, update, remove }
}
