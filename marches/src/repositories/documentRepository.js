import { getDb } from '../db/index.js'
import { buildUpsert } from '../db/sql.js'
import { nowIso } from '../utils/dates.js'

const TABLE = 'consultation_documents'

/**
 * Attachments published alongside an avis — the tender pack, and the notice
 * explaining a cancellation.
 *
 * Only the link is kept. The files stay on the portal: copying a government
 * publication onto this box would mean serving a stale copy of a document whose
 * authoritative version is one hop away.
 */
export function createDocumentRepository(db = getDb()) {
  const findByConsultationId = (consultationId) =>
    db.all(`SELECT * FROM ${TABLE} WHERE consultation_id = ? ORDER BY kind, id`, [consultationId])

  /** Replaces the document set of a consultation; the detail page is the truth. */
  async function replaceForConsultation(consultationId, documents) {
    return db.transaction(async (tx) => {
      await tx.run(`DELETE FROM ${TABLE} WHERE consultation_id = ?`, [consultationId])
      const stored = []
      for (const document of documents) {
        const { sql, params } = buildUpsert(
          TABLE,
          { ...document, consultation_id: consultationId, updated_at: nowIso() },
          ['consultation_id', 'url'],
        )
        const row = await tx.get(sql, params)
        if (row) stored.push(row)
      }
      return stored
    })
  }

  const countAll = async () => Number((await db.get(`SELECT COUNT(*) AS total FROM ${TABLE}`)).total)

  return { findByConsultationId, replaceForConsultation, countAll }
}
