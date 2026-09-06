import { getDb } from '../db/index.js'
import { buildWhere } from '../db/sql.js'
import { consultationClauses, resultClauses } from './filterClauses.js'

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
    // `params` belongs to `where` and must be bound before the two that follow
    // it. Omitting them bound the limit to the first placeholder instead, and
    // every caller until the buyer profile happened to pass a WHERE with no
    // placeholders at all, so the median came back as 0/0 the first time one did.
    const rows = await db.all(
      `SELECT montant_attribue_cents AS amount FROM consultation_results${where}
       ORDER BY montant_attribue_cents LIMIT ? OFFSET ?`,
      [...params, count % 2 === 0 ? 2 : 1, offset],
    )
    const values = rows.map((row) => Number(row.amount))
    if (values.length === 0) return null
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

  /**
   * Awards for work described in the same words as `terms`.
   *
   * Unsuccessful and cancelled results are deliberately *included* here, unlike
   * every other read model in this file: how often work like this ends with
   * nobody awarded is half of what the caller wants to know, and filtering it
   * out would quietly answer a different question.
   *
   * Matched against `objet` and not `search_text`: that column also holds the
   * buyer's name, so a term like "hospitalier" would pull in everything one
   * hospital has ever bought and call it comparable work.
   *
   * The scan is linear — `LIKE '%term%'` cannot use an index — which is why the
   * caller gets a bounded sample rather than the whole match set.
   *
   * @param {string[]} terms significant words from the avis being priced.
   * @param {{limit?: number, minMatches?: number}} [options]
   */
  async function comparables(terms, { limit = 400, minMatches = 2 } = {}) {
    if (terms.length === 0) return []
    const patterns = terms.map((term) => `%${term}%`)
    const score = terms.map(() => 'CASE WHEN objet LIKE ? THEN 1 ELSE 0 END').join(' + ')
    const any = terms.map(() => 'objet LIKE ?').join(' OR ')

    return db.all(
      `SELECT * FROM (
         SELECT id, reference, objet, acheteur, attributaire, montant_attribue_cents, nombre_offres,
                date_publication_resultat, result_status, currency, (${score}) AS score
         FROM consultation_results
         WHERE ${any}
       ) matches
       WHERE score >= ?
       ORDER BY score DESC, date_publication_resultat DESC, id DESC
       LIMIT ?`,
      [...patterns, ...patterns, Math.min(minMatches, terms.length), limit],
    )
  }

  /**
   * Times this buyer has already put this exact purchase out.
   *
   * Not a match — that is the point. 119 award/avis pairs in this database share
   * a buyer and a word-for-word identical objet, and in every one of them the
   * references disagree, always with the award's the lower of the two. They are
   * not two views of one avis; they are the same purchase published twice. And
   * 38% of them were unsuccessful against a 16.6% baseline, so the common story
   * is a first attempt that drew no valid offer and was relaunched.
   *
   * Linking these, which is what a fuzzy matcher would do, would state that an
   * open avis had already been awarded. Showing them as precedent states what
   * actually happened and is far more use to somebody about to bid.
   */
  async function precedents({ acheteur, objet, terms = [], excludeConsultationId = null, limit = 5 }) {
    if (!acheteur || !objet) return []
    const patterns = terms.map((term) => `%${term}%`)
    const score = terms.length
      ? terms.map(() => 'CASE WHEN objet LIKE ? THEN 1 ELSE 0 END').join(' + ')
      : '0'
    // All but one term, so a relaunch that reworded a single word still shows.
    const threshold = Math.max(2, terms.length - 1)

    return db.all(
      `SELECT id, reference, objet, attributaire, montant_attribue_cents, nombre_offres,
              date_publication_resultat, result_status, currency
       FROM consultation_results
       WHERE acheteur = ?
         AND (lower(trim(objet)) = lower(trim(?)) OR (${score}) >= ?)
         AND (consultation_id IS NULL OR consultation_id <> ?)
       ORDER BY date_publication_resultat DESC, id DESC
       LIMIT ?`,
      [acheteur, objet, ...patterns, threshold, excludeConsultationId ?? -1, limit],
    )
  }

  /**
   * One buyer's record, from both halves of the data.
   *
   * Matched on the exact name the portal prints, because that is the only
   * identifier a buyer has here — there is no buyer id anywhere in the portal's
   * markup, and normalising the name would silently merge two directions of the
   * same ministry that publish separately.
   *
   * The cancellation rate is the reason this exists: a buyer who withdraws one
   * avis in six is a different proposition from one who never does, and nothing
   * else in the application would ever show you that.
   */
  async function buyerProfile(name) {
    const [avis, awards] = await Promise.all([
      db.get(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'annule' THEN 1 ELSE 0 END) AS cancelled,
                SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
                MIN(date_publication) AS first_seen, MAX(date_publication) AS last_seen,
                COUNT(DISTINCT categorie) AS categories
         FROM consultations WHERE acheteur = ?`,
        [name],
      ),
      db.get(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN result_status = 'infructueux' THEN 1 ELSE 0 END) AS unsuccessful,
                SUM(CASE WHEN ${AWARDED} THEN montant_attribue_cents ELSE 0 END) AS total_cents,
                AVG(nombre_offres) AS avg_bids,
                COUNT(DISTINCT attributaire) AS winners
         FROM consultation_results WHERE acheteur = ?`,
        [name],
      ),
    ])

    const priced = buildWhere([[AWARDED], ['acheteur = ?', name]])
    return {
      name,
      avis: {
        total: Number(avis.total ?? 0),
        cancelled: Number(avis.cancelled ?? 0),
        open: Number(avis.open ?? 0),
        categories: Number(avis.categories ?? 0),
        firstSeen: avis.first_seen ?? null,
        lastSeen: avis.last_seen ?? null,
      },
      awards: {
        total: Number(awards.total ?? 0),
        unsuccessful: Number(awards.unsuccessful ?? 0),
        totalCents: Number(awards.total_cents ?? 0),
        medianCents: await medianCents(priced.sql, priced.params),
        avgBids: awards.avg_bids === null ? null : Number(awards.avg_bids),
        winners: Number(awards.winners ?? 0),
      },
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

  /**
   * Categories, counted over *consultations* rather than awards.
   *
   * The awards listing does not publish a category at all — zero of ten
   * thousand rows carry one — so ranking awards by category would show an empty
   * table forever. Consultations do carry it, and "what work is being
   * published, and how much of it is still open" is the more useful question
   * anyway when deciding where to compete.
   */
  async function topCategories(filters = {}, limit = 12) {
    const where = buildWhere(consultationClauses(filters, 'consultations'))
    return db.all(
      `SELECT categorie AS label, COUNT(*) AS projects,
              SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_projects
       FROM consultations${where.sql}${where.sql ? ' AND' : ' WHERE'} categorie IS NOT NULL AND categorie <> ''
       GROUP BY categorie ORDER BY projects DESC LIMIT ?`,
      [...where.params, limit],
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
    comparables,
    precedents,
    buyerProfile,
    topWinners: topBy('attributaire'),
    topBuyers: topBy('acheteur'),
    topCategories,
    byMonth,
    outcomes,
  }
}
