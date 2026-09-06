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
  'reference', 'reference_raw', 'match_key', 'objet', 'acheteur', 'acheteur_service', 'categorie', 'nature_prestation',
  'lieu_execution', 'procedure_type', 'mode_passation', 'date_publication', 'date_limite',
  'heure_limite', 'date_ouverture_plis', 'estimation_cents', 'caution_provisoire_cents',
  'qualification', 'agrement', 'is_cancelled', 'date_annulation', 'motif_annulation',
  'detail_url', 'detail_scraped_at', 'source_url', 'source_id',
  'search_text', 'raw_json', 'last_seen_at', 'updated_at',
]

export function createConsultationRepository(db = getDb()) {
  /** Identity lookup: the portal's own id, which is what makes a row unique. */
  const findBySourceId = (sourceId) => db.get(`SELECT * FROM ${TABLE} WHERE source_id = ?`, [sourceId])

  /**
   * References are not unique — each buyer numbers its own avis — so this can
   * return several rows and callers must be able to cope with that.
   */
  const findByReference = (reference) =>
    db.all(`SELECT * FROM ${TABLE} WHERE reference = ? ORDER BY date_publication DESC, id DESC`, [reference])

  const findById = (id) => db.get(`SELECT * FROM ${TABLE} WHERE id = ?`, [id])

  /**
   * Inserts or refreshes a scraped consultation, keyed on `reference`.
   *
   * The incoming row is merged onto the stored one before hashing, so a sparse
   * listing-page pass never erases the richer fields captured from the detail
   * page (see repositories/scrapedRecord.js).
   *
   * @param {object} record the scraped row.
   * @param {{fromDetail?: boolean}} [options] a detail-page scrape is
   *   authoritative and overwrites; once a row has been described by its detail
   *   page, a later listing pass may only fill gaps.
   * @returns {Promise<{row: object, outcome: 'created'|'updated'|'unchanged'}>}
   */
  async function upsert(record, { fromDetail = false } = {}) {
    const existing = await findBySourceId(record.source_id)
    const timestamp = nowIso()
    const incoming = fromDetail ? { ...record, detail_scraped_at: timestamp } : record

    if (!existing) {
      const { sql, params } = buildInsert(TABLE, {
        ...incoming,
        content_hash: hashColumns(incoming, CONSULTATION_HASH_COLUMNS),
      })
      return { row: await db.get(sql, params), outcome: 'created' }
    }

    const merged = mergeScraped(existing, incoming, MUTABLE_COLUMNS, {
      fillOnly: !fromDetail && Boolean(existing.detail_scraped_at),
    })
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
       LEFT JOIN consultation_results r ON r.consultation_id = c.id
       ${where.sql}${order} LIMIT ? OFFSET ?`,
      [...where.params, limit, offset],
    )
    const { total } = await db.get(`SELECT COUNT(*) AS total FROM ${TABLE} c${where.sql}`, where.params)
    return { rows, total: Number(total) }
  }

  /**
   * Recomputes the lifecycle status of every consultation from the facts on
   * record. This is the only writer of `status`: the scraper reports whether the
   * portal cancelled an avis, and everything else — awarded, closed, open — is
   * derived here, so a listing pass can never reset it.
   */
  async function deriveStatus(today = nowIso().slice(0, 10)) {
    const expression = `CASE
        WHEN is_cancelled = 1 THEN 'annule'
        WHEN has_result = 1 THEN 'awarded'
        WHEN date_limite IS NOT NULL AND date_limite < ? THEN 'closed'
        ELSE 'open'
      END`
    const result = await db.run(
      `UPDATE ${TABLE} SET status = ${expression}, updated_at = ? WHERE status <> ${expression}`,
      [today, nowIso(), today],
    )
    return result.changes
  }

  async function update(id, patch) {
    const statement = buildUpdate(TABLE, { ...patch, id, updated_at: nowIso() })
    if (!statement) return findById(id)
    return db.get(statement.sql, statement.params)
  }

  const remove = (id) => db.run(`DELETE FROM ${TABLE} WHERE id = ?`, [id])

  const countAll = async () => Number((await db.get(`SELECT COUNT(*) AS total FROM ${TABLE}`)).total)

  /**
   * Consultations whose detail page has never been read, newest first.
   * The listing card carries no category, nature or article breakdown, so a row
   * is only half a record until its detail page has been fetched.
   */
  const listPendingDetails = (limit = 100) =>
    db.all(
      `SELECT * FROM ${TABLE}
       WHERE detail_url IS NOT NULL AND detail_scraped_at IS NULL
       ORDER BY date_publication DESC, id DESC LIMIT ?`,
      [limit],
    )

  const countPendingDetails = async () =>
    Number(
      (await db.get(`SELECT COUNT(*) AS total FROM ${TABLE} WHERE detail_url IS NOT NULL AND detail_scraped_at IS NULL`))
        .total,
    )

  return {
    findById,
    findBySourceId,
    findByReference,
    upsert,
    search,
    update,
    remove,
    deriveStatus,
    countAll,
    listPendingDetails,
    countPendingDetails,
  }
}
