import { getDb } from '../db/index.js'
import { buildInsert, buildOrderBy, buildUpdate, buildUpsert, buildWhere } from '../db/sql.js'
import { resultClauses } from './filterClauses.js'
import { RESULT_HASH_COLUMNS, hashColumns, mergeScraped } from './scrapedRecord.js'
import { SORTABLE } from '../http/filters.js'
import { nowIso } from '../utils/dates.js'

const TABLE = 'consultation_results'
const LOTS_TABLE = 'result_lots'

const MUTABLE_COLUMNS = [
  'reference', 'reference_raw', 'match_key', 'objet', 'acheteur', 'categorie', 'nature_prestation', 'lieu_execution',
  'procedure_type', 'date_publication_resultat', 'date_attribution', 'attributaire',
  'attributaire_ice', 'montant_attribue_cents', 'currency', 'nombre_offres', 'result_status',
  'detail_url', 'source_url', 'search_text', 'raw_json', 'last_seen_at', 'updated_at',
]

export function createResultRepository(db = getDb()) {
  const findById = (id) => db.get(`SELECT * FROM ${TABLE} WHERE id = ?`, [id])

  /** Identity lookup — awards have no portal id, so this is the derived key. */
  const findByKey = (resultKey) => db.get(`SELECT * FROM ${TABLE} WHERE result_key = ?`, [resultKey])

  /** The award linked to a consultation, by foreign key. */
  const findForConsultation = (consultationId) =>
    db.get(`SELECT * FROM ${TABLE} WHERE consultation_id = ? ORDER BY date_publication_resultat DESC LIMIT 1`, [
      consultationId,
    ])

  /** References are not unique across buyers; this can return several rows. */
  const findByReference = (reference) =>
    db.all(`SELECT * FROM ${TABLE} WHERE reference = ? ORDER BY date_publication_resultat DESC`, [reference])

  const findLots = (resultId) =>
    db.all(`SELECT * FROM ${LOTS_TABLE} WHERE result_id = ? ORDER BY lot_number, id`, [resultId])

  /**
   * Inserts or refreshes a scraped award, keyed on `reference` — the same key the
   * consultations table uses, which is what makes the two datasets joinable.
   * @returns {Promise<{row: object, outcome: 'created'|'updated'|'unchanged'}>}
   */
  async function upsert(record) {
    const existing = await findByKey(record.result_key)
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

  async function replaceLots(resultId, lots) {
    return db.transaction(async (tx) => {
      await tx.run(`DELETE FROM ${LOTS_TABLE} WHERE result_id = ?`, [resultId])
      const inserted = []
      for (const lot of lots) {
        const { sql, params } = buildUpsert(LOTS_TABLE, { ...lot, result_id: resultId }, ['result_id', 'lot_number'])
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
       LEFT JOIN consultations c ON c.id = r.consultation_id
       ${where.sql}${order} LIMIT ? OFFSET ?`,
      [...where.params, limit, offset],
    )
    const { total } = await db.get(`SELECT COUNT(*) AS total FROM ${TABLE} r${where.sql}`, where.params)
    return { rows, total: Number(total) }
  }

  /**
   * Links awards to their consultation.
   *
   * The results listing carries no portal id and no detail page, so the only
   * signal available is (reference, buyer) — `match_key`. A reference alone
   * would be wrong: each buyer numbers its own avis, so "07/2026" belongs to
   * three different communes on a single page of the portal.
   *
   * A link is made only where exactly one consultation matches. An ambiguous
   * key is left unlinked and reported, because attaching the wrong award to a
   * consultation corrupts every invoice built from it.
   */
  async function linkUnmatched() {
    const result = await db.run(
      `UPDATE ${TABLE} SET consultation_id = (
           SELECT c.id FROM consultations c WHERE c.match_key = ${TABLE}.match_key
         ),
         matched_at = ?
       WHERE consultation_id IS NULL
         AND match_key IS NOT NULL
         AND (SELECT COUNT(*) FROM consultations c WHERE c.match_key = ${TABLE}.match_key) = 1`,
      [nowIso()],
    )
    return result.changes
  }

  /** Awards whose (reference, buyer) matches more than one consultation. */
  const countAmbiguous = async () =>
    Number(
      (
        await db.get(
          `SELECT COUNT(*) AS total FROM ${TABLE}
           WHERE consultation_id IS NULL AND match_key IS NOT NULL
             AND (SELECT COUNT(*) FROM consultations c WHERE c.match_key = ${TABLE}.match_key) > 1`,
        )
      ).total,
    )

  const countAll = async () => Number((await db.get(`SELECT COUNT(*) AS total FROM ${TABLE}`)).total)

  const countUnmatched = async () =>
    Number((await db.get(`SELECT COUNT(*) AS total FROM ${TABLE} WHERE consultation_id IS NULL`)).total)

  async function update(id, patch) {
    const statement = buildUpdate(TABLE, { ...patch, id, updated_at: nowIso() })
    if (!statement) return findById(id)
    return db.get(statement.sql, statement.params)
  }

  const remove = (id) => db.run(`DELETE FROM ${TABLE} WHERE id = ?`, [id])

  return {
    findById,
    findByKey,
    findByReference,
    findForConsultation,
    findLots,
    upsert,
    replaceLots,
    search,
    linkUnmatched,
    countAmbiguous,
    countAll,
    countUnmatched,
    update,
    remove,
  }
}
