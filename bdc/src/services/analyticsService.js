import { fromCentimes } from '../utils/money.js'
import { requiredMatches, significantTerms } from '../analytics/terms.js'

/**
 * Award intelligence, for the questions a bidder actually has: what does work
 * like mine go for, who else wins it, and which buyers publish it.
 */
export function createAnalyticsService({ analytics }) {
  const amount = (cents) => (cents === null || cents === undefined ? null : fromCentimes(cents))

  const group = (rows) =>
    rows.map((row) => ({
      label: row.label,
      awards: Number(row.awards),
      total: amount(row.total_cents),
      avgBids: row.avg_bids === null ? null : Math.round(Number(row.avg_bids) * 10) / 10,
    }))

  /**
   * @param {object} filters canonical filters — the same ones the awards list
   *   uses, so a slice on screen can be analysed without a second vocabulary.
   */
  async function overview(filters = {}) {
    const [summary, winners, buyers, categories, months, outcomes] = await Promise.all([
      analytics.summary(filters),
      analytics.topWinners(filters),
      analytics.topBuyers(filters),
      analytics.topCategories(filters),
      analytics.byMonth(filters),
      analytics.outcomes(filters),
    ])

    const settled = outcomes.reduce((sum, row) => sum + Number(row.awards), 0)
    const unsuccessful = Number(outcomes.find((row) => row.status === 'infructueux')?.awards ?? 0)

    return {
      summary: {
        ...summary,
        total: amount(summary.totalCents),
        median: amount(summary.medianCents),
        min: amount(summary.minCents),
        max: amount(summary.maxCents),
        avgBids: summary.avgBids === null ? null : Math.round(summary.avgBids * 10) / 10,
        // How often an avis in this slice ends with nobody awarded. Worth
        // knowing before spending a week on a quote.
        unsuccessfulRate: settled > 0 ? Math.round((unsuccessful / settled) * 1000) / 10 : null,
      },
      winners: group(winners),
      buyers: group(buyers),
      categories: categories.map((row) => ({
        label: row.label,
        projects: Number(row.projects),
        openProjects: Number(row.open_projects ?? 0),
      })),
      months: months
        .map((row) => ({ month: row.month, awards: Number(row.awards), total: amount(row.total_cents) }))
        .reverse(),
      outcomes: outcomes.map((row) => ({ status: row.status, awards: Number(row.awards) })),
    }
  }

  /**
   * What work like this has actually gone for — the question someone about to
   * price a quote is holding.
   *
   * Deliberately not a single number. A median with no sample size behind it
   * invites being trusted, so the caller gets the spread, how many awards it
   * was drawn from, how contested they were, and how often work described this
   * way ends with nobody awarded at all. Fewer than MIN_SAMPLE comparables and
   * it reports that it cannot say, rather than quoting a median of three.
   *
   * @param {{objet?: string, categorie?: string}} consultation
   */
  async function benchmark(consultation) {
    const terms = significantTerms(
      [consultation?.objet, consultation?.nature_prestation].filter(Boolean).join(' '),
      { exclude: [consultation?.acheteur, consultation?.acheteur_service, consultation?.lieu_execution].filter(Boolean).join(' ') },
    )
    const empty = { terms, currency: 'MAD', sampleSize: 0, awarded: 0, enough: false, median: null,
      low: null, high: null, avgBids: null, unsuccessfulRate: null, examples: [] }
    if (terms.length === 0) return empty

    const rows = await analytics.comparables(terms, { minMatches: requiredMatches(terms) })
    if (rows.length === 0) return empty

    const priced = rows
      .filter((row) => row.result_status === 'attribue' && Number(row.montant_attribue_cents) > 0)
      .map((row) => Number(row.montant_attribue_cents))
      .sort((a, b) => a - b)

    const settled = rows.filter((row) => row.result_status).length
    const unsuccessful = rows.filter((row) => row.result_status === 'infructueux').length
    const bids = rows.map((row) => Number(row.nombre_offres)).filter((n) => Number.isFinite(n) && n > 0)

    return {
      terms,
      currency: rows.find((row) => row.currency)?.currency ?? 'MAD',
      sampleSize: rows.length,
      awarded: priced.length,
      enough: priced.length >= MIN_SAMPLE,
      median: amount(quantile(priced, 0.5)),
      low: amount(quantile(priced, 0.25)),
      high: amount(quantile(priced, 0.75)),
      avgBids: bids.length ? Math.round((bids.reduce((a, b) => a + b, 0) / bids.length) * 10) / 10 : null,
      unsuccessfulRate: settled > 0 ? Math.round((unsuccessful / settled) * 1000) / 10 : null,
      // The rows themselves, so the number can be checked rather than believed.
      examples: rows.slice(0, 6).map((row) => ({
        id: row.id,
        reference: row.reference,
        objet: row.objet,
        acheteur: row.acheteur,
        attributaire: row.attributaire,
        montant_attribue: amount(row.montant_attribue_cents),
        nombre_offres: row.nombre_offres,
        date_publication_resultat: row.date_publication_resultat,
        result_status: row.result_status,
        score: Number(row.score),
      })),
    }
  }

  /**
   * Everything on record about one buyer: what they publish, how often they
   * withdraw it, what it settles for, and who keeps winning it.
   *
   * @param {string} name the buyer exactly as the portal prints it.
   * @param {object} listings the consultation read model, which serves both the
   *   avis and the award tables shown here.
   */
  async function buyer(name, listings) {
    const filters = { acheteur: name }
    const [profile, winners, recentAvis, recentAwards] = await Promise.all([
      analytics.buyerProfile(name),
      analytics.topWinners(filters, 8),
      listings.search(filters, { limit: 10, offset: 0, sort: 'date_publication:desc' }),
      listings.searchResults(filters, { limit: 10, offset: 0 }),
    ])

    const settled = profile.awards.total
    return {
      name,
      avis: profile.avis,
      // Expressed as a rate as well as a count: "12 cancelled" means nothing
      // without knowing whether it is out of 20 or out of 2,000.
      cancellationRate: profile.avis.total > 0
        ? Math.round((profile.avis.cancelled / profile.avis.total) * 1000) / 10
        : null,
      unsuccessfulRate: settled > 0 ? Math.round((profile.awards.unsuccessful / settled) * 1000) / 10 : null,
      awards: {
        ...profile.awards,
        total: settled,
        totalAmount: amount(profile.awards.totalCents),
        median: amount(profile.awards.medianCents),
        avgBids: profile.awards.avgBids === null ? null : Math.round(profile.awards.avgBids * 10) / 10,
      },
      winners: group(winners),
      recentAvis: recentAvis.data,
      recentAwards: recentAwards.data,
    }
  }

  /**
   * What happened last time this buyer published this purchase.
   *
   * @param {object} consultation the avis being looked at.
   */
  async function precedents(consultation) {
    if (!consultation?.acheteur || !consultation?.objet) return []
    const terms = significantTerms(consultation.objet, { exclude: consultation.acheteur })
    const rows = await analytics.precedents({
      acheteur: consultation.acheteur,
      objet: consultation.objet,
      terms,
      excludeConsultationId: consultation.id ?? null,
    })
    return rows.map((row) => ({
      id: row.id,
      reference: row.reference,
      objet: row.objet,
      attributaire: row.attributaire,
      montant_attribue: amount(row.montant_attribue_cents),
      currency: row.currency ?? 'MAD',
      nombre_offres: row.nombre_offres,
      date_publication_resultat: row.date_publication_resultat,
      result_status: row.result_status,
    }))
  }

  return { overview, benchmark, buyer, precedents }
}

/** Below this many priced comparables, the spread is noise and is not shown. */
const MIN_SAMPLE = 5

/** Nearest-rank quantile over an ascending array of integers. */
function quantile(sorted, fraction) {
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index]
}
