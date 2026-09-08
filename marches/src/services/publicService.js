/**
 * The handful of numbers the front door shows.
 *
 * Read at request time rather than cached: a landing page that claims a scale
 * the database no longer has is worse than one that claims none, and these are
 * four COUNT(*)s against indexed tables.
 */
export function createPublicService({ consultations, analytics, jobs }) {
  async function stats() {
    // Consultations and the buyers publishing them. The article and award
    // counters that used to sit here were removed with the screens behind them:
    // this portal publishes no article breakdown, and an award arrives later as
    // a separate résultat définitif notice nothing here crawls, so both would
    // have read zero on a page whose whole job is to state a real scale.
    const [avis, summary] = await Promise.all([consultations.countAll(), analytics.summary({})])

    return [
      { label: 'public.stats.avis', value: format(avis) },
      { label: 'public.stats.buyers', value: format(summary.buyers) },
    ]
  }

  /**
   * How current the data is, for a page anyone can read.
   *
   * Deliberately not the System screen: no disk, no backups, no versions, no
   * error text. What a reader outside the organisation needs to know is whether
   * what they are looking at is fresh, and nothing else here is their business.
   */
  async function status() {
    const recent = await jobs.listRecent(20)
    const last = recent.find((job) => job.status === 'success' && job.source !== 'backfill') ?? null
    const ageHours = last?.finished_at
      ? Math.round((Date.now() - Date.parse(last.finished_at)) / 3_600_000)
      : null

    return {
      lastCrawlAt: last?.finished_at ?? null,
      ageHours,
      // A daily crawl that has not run for two days is stale, whatever the
      // reason. This is the same threshold the internal canary uses.
      fresh: ageHours !== null && ageHours <= 48,
      counts: await stats(),
    }
  }

  return { stats, status }
}

/** Thin space between groups: readable in all three locales, and not a comma,
 *  which means a decimal point to a French reader. */
const format = (value) => Number(value ?? 0).toLocaleString('fr-FR').replace(/ | /g, ' ')
