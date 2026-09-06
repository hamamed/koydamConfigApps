import { getDb } from '../db/index.js'
import { buildIn, buildUpsert } from '../db/sql.js'
import { nowIso } from '../utils/dates.js'

const TABLE = 'article_translations'

/**
 * Stored translations, one per article and language.
 *
 * Cached because a translation costs money and the source text never changes:
 * an article's designation is what the buyer published, and it is only rewritten
 * when the detail page is re-read — which replaces the article row and takes the
 * translation with it through the foreign key, which is the correct outcome.
 */
export function createTranslationRepository(db = getDb()) {
  async function findForArticles(articleIds, locale) {
    const clause = buildIn('article_id', articleIds)
    if (!clause) return new Map()
    const [fragment, ...params] = clause
    const rows = await db.all(`SELECT * FROM ${TABLE} WHERE ${fragment} AND locale = ?`, [...params, locale])
    return new Map(rows.map((row) => [row.article_id, row]))
  }

  async function saveMany(rows, locale, model) {
    return db.transaction(async (tx) => {
      const saved = []
      for (const row of rows) {
        const { sql, params } = buildUpsert(
          TABLE,
          {
            article_id: row.id,
            locale,
            designation: row.designation,
            description: row.description,
            model,
            created_at: nowIso(),
          },
          ['article_id', 'locale'],
        )
        saved.push(await tx.get(sql, params))
      }
      return saved
    })
  }

  const countAll = async () => Number((await db.get(`SELECT COUNT(*) AS total FROM ${TABLE}`)).total)

  return { findForArticles, saveMany, countAll }
}
