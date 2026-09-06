import { getDb } from '../db/index.js'
import { buildInsert, buildOrderBy, buildUpdate, buildWhere } from '../db/sql.js'
import { consultationClauses } from './filterClauses.js'
import { CONSULTATION_HASH_COLUMNS, hashColumns, mergeScraped } from './scrapedRecord.js'
import { SORTABLE } from '../http/filters.js'
import { nowIso } from '../utils/dates.js'

const TABLE = 'consultations'

/**
 * Columns refreshed on every re-scrape; `first_seen_at` / `created_at` are
 * preserved. `lots_count` is deliberately absent: after the first insert it is
 * derived from the stored articles by articleRepository.replaceForConsultation,
 * and letting a listing-page pass reset it to 0 would flip the row on every
 * crawl.
 */
const MUTABLE_COLUMNS = [
  'reference_raw', 'objet', 'acheteur', 'acheteur_service', 'categorie', 'nature_prestation',
  'lieu_execution', 'procedure_type', 'mode_passation', 'date_publication', 'date_limite',
  'heure_limite', 'date_ouverture_plis', 'estimation_cents', 'caution_provisoire_cents',
  'qualification', 'agrement', 'detail_url', 'source_url', 'source_id',
  'search_text', 'raw_json', 'last_seen_at', 'updated_at',
]

export function createConsultationRepository(db = getDb()) {
  const findByReference = (reference) =>
    db.get(`SELECT * FROM ${TABLE} WHERE reference = ?`, [reference])

  const findById = (id) => db.get(`SELECT * FROM ${TABLE} WHERE id = ?`, [id])

  /**
   * Inserts or refreshes a scraped consultation, keyed on `reference`.
   *
   * The incoming row is merged onto the stored one before hashing, so a sparse
   * listing-page pass never erases the richer fields captured from the detail
   * page (see repositories/scrapedRecord.js).
   * @returns {Promise<{row: object, outcome: 'created'|'updated'|'unchanged'}>}
   */
  async function upsert(record) {
    const existing = await findByReference(record.reference)
    const timestamp = nowIso()

    if (!existing) {
      const { sql, params } = buildInsert(TABLE, {
        ...record,
        content_hash: hashColumns(record, CONSULTATION_HASH_COLUMNS),
      })
      return { row: await db.get(sql, params), outcome: 'created' }
    }

    const merged = mergeScraped(existing, record, MUTABLE_COLUMNS)
    merged.content_hash = hashColumns(merged, CONSULTATION_HASH_COLUMNS)

    if (existing.content_hash === merged.content_hash) {
      await db.run(`UPDATE ${TABLE} SET last_seen_at = ? WHERE id = ?`, [timestamp, existing.id])
      return { row: existing, outcome: 'unchanged' }
    }

    const update = buildUpdate(TABLE, { ...merged, id: existing.id, last_seen_at: timestamp, updated_at: timestamp })
    return { row: await db.get(update.sql, update.params), outcome: 'updated' }
  }

  /** Paginated, filtered listing. Returns `{ rows, total }`. */
  async function search(filters = {}, { limit, offset, sort } = {}) {
    const where = buildWhere(consultationClauses(filters, 'c'))
    const order = buildOrderBy(sort, SORTABLE.consultations, 'date_publication')

    const rows = await db.all(
      `SELECT c.*, r.attributaire, r.montant_attribue_cents, r.date_attribution, r.result_status
       FROM ${TABLE} c
       LEFT JOIN consultation_results r ON r.reference = c.reference
       ${where.sql}${order} LIMIT ? OFFSET ?`,
      [...where.params, limit, offset],
    )
    const { total } = await db.get(`SELECT COUNT(*) AS total FROM ${TABLE} c${where.sql}`, where.params)
    return { rows, total: Number(total) }
  }

  /** Marks a consultation as having a published award, used by the matcher. */
  const markHasResult = (reference, hasResult = true) =>
    db.run(`UPDATE ${TABLE} SET has_result = ?, status = ?, updated_at = ? WHERE reference = ?`, [
      hasResult ? 1 : 0,
      hasResult ? 'awarded' : 'open',
      nowIso(),
      reference,
    ])

  /** Flags consultations whose closing date has passed as `closed`. */
  const closeExpired = (today = nowIso().slice(0, 10)) =>
    db.run(
      `UPDATE ${TABLE} SET status = 'closed', updated_at = ? WHERE status = 'open' AND date_limite IS NOT NULL AND date_limite < ?`,
      [nowIso(), today],
    )

  async function update(id, patch) {
    const statement = buildUpdate(TABLE, { ...patch, id, updated_at: nowIso() })
    if (!statement) return findById(id)
    return db.get(statement.sql, statement.params)
  }

  const remove = (id) => db.run(`DELETE FROM ${TABLE} WHERE id = ?`, [id])

  const countAll = async () => Number((await db.get(`SELECT COUNT(*) AS total FROM ${TABLE}`)).total)

  const listPendingDetails = (limit = 50) =>
    db.all(
      `SELECT * FROM ${TABLE} WHERE detail_url IS NOT NULL AND lots_count = 0 ORDER BY last_seen_at DESC LIMIT ?`,
      [limit],
    )

  return { findById, findByReference, upsert, search, update, remove, markHasResult, closeExpired, countAll, listPendingDetails }
}
