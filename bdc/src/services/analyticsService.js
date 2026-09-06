import { fromCentimes } from '../utils/money.js'

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

  return { overview }
}
