import { createHttpClient } from './httpClient.js'
import { createMarcheScraper } from './marcheScraper.js'
import { createExclusionScraper } from './exclusionScraper.js'
import { ConflictError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

const log = logger.child('[scraper:runner]')

// 'exclusions' is deliberately outside 'all': it is a small, near-static list
// on a different portal, and re-reading it on every daily crawl would spend
// requests on a page that changes a few times a year.
export const SOURCES = Object.freeze(['marches', 'exclusions', 'all'])

/** An ISO date N days back, the format the portal's date filters require. */
function daysAgo(days) {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - Math.max(0, Number(days) || 0))
  return date.toISOString().slice(0, 10)
}

/**
 * Orchestrates a full scrape: open consultations, then results, then the
 * matching pass — recording progress in `scrape_jobs` so the admin dashboard can
 * report on it.
 */
export function createScraperRunner({ db, consultations, exclusions, jobs, settings, http }) {
  // Built per run from the current settings, so changing the delay or the user
  // agent in the panel applies to the next crawl without a restart. A client
  // passed in wins, which is what the tests use to serve fixtures.
  const client =
    http ??
    createHttpClient(settings ? { resolveOptions: () => settings.section('scraper') } : undefined)

  const marcheScraper = createMarcheScraper({ http: client, consultations, settings })
  const exclusionScraper = createExclusionScraper({ http: client, exclusions })

  /**
   * @param {object} options
   * @param {'consultations'|'results'|'all'} [options.source]
   * @param {object} [options.filters] portal search filters.
   * @param {number} [options.maxPages]
   * @param {number} [options.startPage] resume a deep pass where one stopped
   * @param {boolean} [options.fetchDetails]
   * @param {boolean} [options.backfillDetails] after crawling, read the detail
   *   page of every consultation that has never had one read.
   * @param {number} [options.backfillLimit] cap on pages fetched by that pass.
   * @param {number} [options.sinceDays] only fetch items published in the last
   *   N days. This is how the daily run stays small and still catches
   *   everything new.
   * @param {string} [options.triggeredBy] audit trail for the admin panel.
   * @throws {ConflictError} when a job for the same source is already running.
   */
  async function run(options = {}) {
    const {
      source = 'all',
      maxPages,
      startPage,
      fetchDetails,
      backfillDetails = false,
      backfillLimit,
      sinceDays,
      pageSize,
      triggeredBy = 'system',
    } = options

    // The listings are ordered by deadline, not by publication date, so a new
    // avis does not appear on page 1 — crawling "the first N pages" would miss
    // most of them. A publication-date floor asks the portal for exactly what is
    // new, whatever order it returns things in.
    const filters = { ...(options.filters ?? {}), ...(sinceDays ? { datePublicationStart: daysAgo(sinceDays) } : {}) }

    await jobs.expireStale()
    const running = await jobs.findRunning()
    if (running) {
      throw new ConflictError(`A "${running.source}" crawl is already running (job #${running.id})`)
    }

    const job = await jobs.start({ source, triggeredBy, params: { filters, maxPages, fetchDetails, sinceDays } })
    log.info('job started', { jobId: job.id, source })

    const totals = { pagesScraped: 0, itemsFound: 0, itemsCreated: 0, itemsUpdated: 0, matchesLinked: 0 }
    const detail = {}

    /**
     * Rolls one scraper's numbers into the job's.
     *
     * Not optional bookkeeping: the dashboard and the health canary both read
     * these, and leaving them at zero made a crawl that had just stored three
     * thousand consultations report "the last crawl found nothing at all". The
     * service looked dead from the outside while working perfectly.
     */
    const record = (stats) => {
      if (!stats) return stats
      for (const key of ['pagesScraped', 'itemsFound', 'itemsCreated', 'itemsUpdated']) {
        totals[key] += Number(stats[key] ?? 0)
      }
      return stats
    }

    try {
      if (source === 'marches' || source === 'all') {
        detail.marches = record(await marcheScraper.scrape({ maxPages, fetchDetails }))
      }

      if (source === 'exclusions') {
        detail.exclusions = record(await exclusionScraper.scrape())
      }
      // Awards on this portal are published as "résultats définitifs" on pages
      // this crawler does not read yet, so nothing links a marché to one.
      totals.matchesLinked = detail.matching?.matchesLinked ?? 0

      const finished = await jobs.finish(job.id, { status: 'success', stats: totals, detail: summarize(detail) })
      log.info('job finished', { jobId: job.id, ...totals })
      return { job: finished, stats: totals, detail }
    } catch (error) {
      await jobs.finish(job.id, { status: 'failed', stats: totals, error: error.message })
      log.error('job failed', { jobId: job.id, message: error.message })
      throw error
    }
  }

  /** The few numbers worth keeping per run; the raw stats carry error lists. */
  const summarize = (detail) => ({
    consultations: pick(detail.consultations),
    results: pick(detail.results),
    backfill: detail.backfill
      ? { processed: detail.backfill.consultationsProcessed, articles: detail.backfill.articlesSaved }
      : null,
    matching: detail.matching ?? null,
  })

  const pick = (stats) =>
    stats
      ? {
          pages: stats.pagesScraped,
          found: stats.itemsFound,
          created: stats.itemsCreated,
          updated: stats.itemsUpdated,
          unchanged: stats.itemsUnchanged,
          errors: stats.errors?.length ?? 0,
        }
      : null

  const accumulate = (totals, stats) => {
    totals.pagesScraped += stats.pagesScraped ?? 0
    totals.itemsFound += stats.itemsFound ?? 0
    totals.itemsCreated += stats.itemsCreated ?? 0
    totals.itemsUpdated += stats.itemsUpdated ?? 0
  }

  /** Runs only the detail backlog, recorded as its own job. */
  async function backfillDetailsJob(options = {}) {
    const { triggeredBy = 'system', limit, refreshAll = false } = options
    await jobs.expireStale()
    const running = await jobs.findRunning()
    if (running) {
      throw new ConflictError(`A "${running.source}" crawl is already running (job #${running.id})`)
    }

    const job = await jobs.start({ source: 'backfill', triggeredBy, params: { limit, refreshAll } })
    try {
      // Re-reading everything is how a new field on the detail page reaches rows
      // that were scraped before it was parsed.
      const staled = refreshAll ? await consultations.markDetailsStale() : 0
      if (staled) log.info('marked detail pages stale', { rows: staled })

      const stats = await marcheScraper.scrape({ maxPages: 1, fetchDetails: true, until: () => true })
      const finished = await jobs.finish(job.id, {
        status: 'success',
        stats: { pagesScraped: stats.pagesScraped, itemsUpdated: stats.consultationsProcessed },
      })
      log.info('backfill finished', stats)
      return { job: finished, stats }
    } catch (error) {
      await jobs.finish(job.id, { status: 'failed', error: error.message })
      throw error
    }
  }

  return { run, backfillDetails: backfillDetailsJob, marcheScraper, exclusionScraper, http: client }
}
