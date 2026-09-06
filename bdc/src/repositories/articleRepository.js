import { getDb } from '../db/index.js'
import { buildIn, buildUpsert } from '../db/sql.js'
import { nowIso } from '../utils/dates.js'

const TABLE = 'consultation_articles'

export function createArticleRepository(db = getDb()) {
  const findById = (id) => db.get(`SELECT * FROM ${TABLE} WHERE id = ?`, [id])

  const findByConsultationId = (consultationId) =>
    db.all(`SELECT * FROM ${TABLE} WHERE consultation_id = ? ORDER BY lot_number, article_number, id`, [consultationId])

  /** Loads a specific set of articles, used when building an invoice. */
  async function findByIds(ids) {
    const clause = buildIn('id', ids)
    if (!clause) return []
    const [fragment, ...params] = clause
    return db.all(`SELECT * FROM ${TABLE} WHERE ${fragment}`, params)
  }

  /**
   * Replaces the article set of a consultation in one transaction.
   * Articles are re-scraped wholesale, so a diff would add complexity without
   * buying anything; the unique key still makes the write idempotent.
   */
  async function replaceForConsultation(consultationId, articles) {
    return db.transaction(async (tx) => {
      await tx.run(`DELETE FROM ${TABLE} WHERE consultation_id = ?`, [consultationId])
      const inserted = []
      for (const article of articles) {
        const record = { ...article, consultation_id: consultationId, updated_at: nowIso() }
        const { sql, params } = buildUpsert(TABLE, record, [
          'consultation_id',
          'lot_number',
          'article_number',
          'designation',
        ])
        const row = await tx.get(sql, params)
        if (row) inserted.push(row)
      }
      await tx.run('UPDATE consultations SET lots_count = ?, updated_at = ? WHERE id = ?', [
        inserted.length,
        nowIso(),
        consultationId,
      ])
      return inserted
    })
  }

  const countAll = async () => Number((await db.get(`SELECT COUNT(*) AS total FROM ${TABLE}`)).total)

  return { findById, findByIds, findByConsultationId, replaceForConsultation, countAll }
}
