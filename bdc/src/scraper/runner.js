import { createHttpClient } from './httpClient.js'
import { createConsultationScraper } from './consultationScraper.js'
import { createResultScraper } from './resultScraper.js'
import { createMatcher } from './matcher.js'
import { ConflictError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

const log = logger.child('[scraper:runner]')

export const SOURCES = Object.freeze(['consultations', 'results', 'all'])

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
export function createScraperRunner({ db, consultations, articles, documents, results, jobs, settings, http }) {
  // Built per run from the current settings, so changing the delay or the user
  // agent in the panel applies to the next crawl without a restart. A client
  // passed in wins, which is what the tests use to serve fixtures.
  const client =
    http ??
    createHttpClient(settings ? { resolveOptions: () => settings.section('scraper') } : undefined)

  const consultationScraper = createConsultationScraper({ http: client, consultations, articles, documents, settings })
  const resultScraper = createResultScraper({ http: client, results, settings })
  const matcher = createMatcher({ db, consultations, results })

  /**
   * @param {object} options
   * @param {'consultations'|'results'|'all'} [options.source]
   * @param {object} [options.filters] portal search filters.
   * @param {number} [options.maxPages]
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

    const running = await jobs.findRunning(source)
    if (running) throw new ConflictError(`A "${source}" scrape job is already running (job #${running.id})`)

    const job = await jobs.start({ source, triggeredBy, params: { filters, maxPages, fetchDetails, sinceDays } })
    log.info('job started', { jobId: job.id, source })

    const totals = { pagesScraped: 0, itemsFound: 0, itemsCreated: 0, itemsUpdated: 0, matchesLinked: 0 }
    const detail = {}

    try {
      if (source === 'consultations' || source === 'all') {
        detail.consultations = await consultationScraper.scrape({ filters, maxPages, fetchDetails, pageSize })
        accumulate(totals, detail.consultations)
      }
      if (source === 'results' || source === 'all') {
        detail.results = await resultScraper.scrape({ filters, maxPages, fetchDetails, pageSize })
        accumulate(totals, detail.results)
      }

      if (backfillDetails) {
        detail.backfill = await consultationScraper.backfillDetails({ limit: backfillLimit })
        totals.pagesScraped += detail.backfill.pagesScraped
      }

      detail.matching = await matcher.run()
      totals.matchesLinked = detail.matching.matchesLinked

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
    const running = await jobs.findRunning('backfill')
    if (running) throw new ConflictError(`A backfill is already running (job #${running.id})`)

    const job = await jobs.start({ source: 'backfill', triggeredBy, params: { limit, refreshAll } })
    try {
      // Re-reading everything is how a new field on the detail page reaches rows
      // that were scraped before it was parsed.
      const staled = refreshAll ? await consultations.markDetailsStale() : 0
      if (staled) log.info('marked detail pages stale', { rows: staled })

      const stats = await consultationScraper.backfillDetails({ limit })
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

  return { run, backfillDetails: backfillDetailsJob, matcher, consultationScraper, resultScraper, http: client }
}
