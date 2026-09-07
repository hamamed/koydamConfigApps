import { normalize } from '../utils/text.js'

/**
 * Free-text search over `search_text`, and how to rank what it finds.
 *
 * `search_text` is written by the scraper already normalised — lowercased and
 * stripped of accents — so a query has to be normalised the same way or
 * "marché" never matches "marche".
 *
 * The old behaviour was one substring LIKE over the whole query, which meant a
 * two-word search only matched when those two words happened to be adjacent:
 * "produits nettoyage" found nothing, while "produits de nettoyage" found rows.
 * Every term is now required independently, and relevance orders what comes back.
 */

/** Words worth matching on. Single characters are noise in a LIKE. */
export function searchTerms(query) {
  const seen = new Set()
  return normalize(query ?? '')
    .split(/[^a-z0-9/]+/)
    .filter((term) => term.length >= 2)
    .filter((term) => (seen.has(term) ? false : seen.add(term)))
    .slice(0, 8)
}

/**
 * One clause per term, all of which must match. Returned as the clause pairs
 * `buildWhere` expects, so free text composes with every other filter.
 */
export function searchClauses(query, column) {
  const terms = searchTerms(query)
  if (terms.length === 0) return []
  return terms.map((term) => [`${column} LIKE ?`, `%${term}%`])
}

/**
 * Relevance, highest first.
 *
 * A hit in the objet counts for more than a hit anywhere in `search_text`,
 * which also holds the reference and the buyer's name — otherwise searching for
 * a common word ranks every avis one large ministry published above the one
 * actually about that word. The whole query appearing verbatim in the objet is
 * worth more than its words appearing separately.
 *
 * @returns {{sql: string, params: unknown[]}} an ORDER BY fragment, or empty
 *   when there is nothing to rank by.
 */
export function relevanceOrder(query, { objet, tiebreak }) {
  const terms = searchTerms(query)
  if (terms.length === 0) return { sql: '', params: [] }

  const phrase = normalize(query)
  const parts = [`CASE WHEN LOWER(${objet}) LIKE ? THEN ${PHRASE_WEIGHT} ELSE 0 END`]
  const params = [`%${phrase}%`]
  for (const term of terms) {
    parts.push(`CASE WHEN LOWER(${objet}) LIKE ? THEN 1 ELSE 0 END`)
    params.push(`%${term}%`)
  }

  return { sql: ` ORDER BY (${parts.join(' + ')}) DESC, ${tiebreak}`, params }
}

/** A verbatim phrase in the objet outweighs any number of scattered words. */
const PHRASE_WEIGHT = 10

/**
 * The sort as a column, or nothing.
 *
 * `relevance` is in the sortable allow-list so the API accepts it, but it is
 * not a column: handing it to buildOrderBy produced `ORDER BY c.relevance` and
 * a SQL error the moment somebody asked to sort by relevance without a query.
 */
export const columnSort = (sort) => (String(sort ?? '').startsWith('relevance') ? undefined : sort)
