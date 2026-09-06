import { getDb } from '../db/index.js'
import { buildWhere } from '../db/sql.js'
import { resultClauses } from './filterClauses.js'

/**
 * Read models over the award history.
 *
 * The point is pricing and competition: what contracts like mine actually go
 * for, who keeps winning them, and which buyers publish the work. All of it is
 * already in `consultation_results`; none of it needed new scraping.
 *
 * Every aggregate ignores unsuccessful and cancelled awards — an avis that was
 * never awarded has no price and would drag every median toward zero.
 */
const AWARDED = "result_status = 'attribue' AND montant_attribue_cents IS NOT NULL AND montant_attribue_cents > 0"

export function createAnalyticsRepository(db = getDb()) {
  const scope = (filters) => {
    const where = buildWhere([[AWARDED], ...resultClauses(filters, 'consultation_results')])
    return { sql: where.sql, params: where.params }
  }

  /**
   * The median matters more than the mean here: a handful of very large
   * contracts pull an average far above what a typical bon de commande is
   * worth, which is exactly the number someone would price against.
   */
  async function medianCents(where, params) {
    const { total } = await db.get(`SELECT COUNT(*) AS total FROM consultation_results${where}`, params)
    const count = Number(total)
    if (count === 0) return null
    const offset = Math.floor((count - 1) / 2)
    const rows = await db.all(
      `SELECT montant_attribue_cents AS amount FROM consultation_results${where}
       ORDER BY montant_attribue_cents LIMIT ? OFFSET ?`,
      [count % 2 === 0 ? 2 : 1, offset],
    )
    const values = rows.map((row) => Number(row.amount))
    return Math.round(values.reduce((a, b) => a + b, 0) / values.length)
  }

  /** Headline numbers for the filtered slice. */
  async function summary(filters = {}) {
    const { sql, params } = scope(filters)
    const row = await db.get(
      `SELECT COUNT(*) AS awards, SUM(montant_attribue_cents) AS total_cents,
              MIN(montant_attribue_cents) AS min_cents, MAX(montant_attribue_cents) AS max_cents,
              AVG(nombre_offres) AS avg_bids, COUNT(DISTINCT attributaire) AS winners,
              COUNT(DISTINCT acheteur) AS buyers
       FROM consultation_results${sql}`,
      params,
    )
    return {
      awards: Number(row.awards ?? 0),
      totalCents: Number(row.total_cents ?? 0),
      minCents: row.min_cents === null ? null : Number(row.min_cents),
      maxCents: row.max_cents === null ? null : Number(row.max_cents),
      medianCents: await medianCents(sql, params),
      avgBids: row.avg_bids === null ? null : Number(row.avg_bids),
      winners: Number(row.winners ?? 0),
      buyers: Number(row.buyers ?? 0),
    }
  }

  /** Generic "top N by group", used for winners, buyers and categories. */
  const topBy = (column) => async (filters = {}, limit = 12) => {
    const { sql, params } = scope(filters)
    return db.all(
      `SELECT ${column} AS label, COUNT(*) AS awards, SUM(montant_attribue_cents) AS total_cents,
              AVG(nombre_offres) AS avg_bids
       FROM consultation_results${sql}${sql ? ' AND' : ' WHERE'} ${column} IS NOT NULL AND ${column} <> ''
       GROUP BY ${column} ORDER BY awards DESC, total_cents DESC LIMIT ?`,
      [...params, limit],
    )
  }

  /** Awards per month, so a seasonal pattern in publication is visible. */
  async function byMonth(filters = {}, months = 12) {
    const { sql, params } = scope(filters)
    return db.all(
      `SELECT substr(date_publication_resultat, 1, 7) AS month, COUNT(*) AS awards,
              SUM(montant_attribue_cents) AS total_cents
       FROM consultation_results${sql}${sql ? ' AND' : ' WHERE'} date_publication_resultat IS NOT NULL
       GROUP BY month ORDER BY month DESC LIMIT ?`,
      [...params, months],
    )
  }

  /** How often an avis goes unawarded — a real risk when planning a bid. */
  async function outcomes(filters = {}) {
    const where = buildWhere(resultClauses(filters, 'consultation_results'))
    return db.all(
      `SELECT COALESCE(result_status, 'inconnu') AS status, COUNT(*) AS awards
       FROM consultation_results${where.sql} GROUP BY status ORDER BY awards DESC`,
      where.params,
    )
  }

  return {
    summary,
    topWinners: topBy('attributaire'),
    topBuyers: topBy('acheteur'),
    topCategories: topBy('categorie'),
    byMonth,
    outcomes,
  }
}
