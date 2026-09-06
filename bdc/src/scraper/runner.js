import { createHttpClient } from './httpClient.js'
import { createConsultationScraper } from './consultationScraper.js'
import { createResultScraper } from './resultScraper.js'
import { createMatcher } from './matcher.js'
import { ConflictError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

const log = logger.child('[scraper:runner]')

export const SOURCES = Object.freeze(['consultations', 'results', 'all'])

/**
 * Orchestrates a full scrape: open consultations, then results, then the
 * matching pass — recording progress in `scrape_jobs` so the admin dashboard can
 * report on it.
 */
export function createScraperRunner({ db, consultations, articles, results, jobs, http = createHttpClient() }) {
  const consultationScraper = createConsultationScraper({ http, consultations, articles })
  const resultScraper = createResultScraper({ http, results })
  const matcher = createMatcher({ db, consultations, results })

  /**
   * @param {object} options
   * @param {'consultations'|'results'|'all'} [options.source]
   * @param {object} [options.filters] portal search filters.
   * @param {number} [options.maxPages]
   * @param {boolean} [options.fetchDetails]
   * @param {string} [options.triggeredBy] audit trail for the admin panel.
   * @throws {ConflictError} when a job for the same source is already running.
   */
  async function run(options = {}) {
    const { source = 'all', filters = {}, maxPages, fetchDetails, triggeredBy = 'system' } = options

    const running = await jobs.findRunning(source)
    if (running) throw new ConflictError(`A "${source}" scrape job is already running (job #${running.id})`)

    const job = await jobs.start({ source, triggeredBy, params: { filters, maxPages, fetchDetails } })
    log.info('job started', { jobId: job.id, source })

    const totals = { pagesScraped: 0, itemsFound: 0, itemsCreated: 0, itemsUpdated: 0, matchesLinked: 0 }
    const detail = {}

    try {
      if (source === 'consultations' || source === 'all') {
        detail.consultations = await consultationScraper.scrape({ filters, maxPages, fetchDetails })
        accumulate(totals, detail.consultations)
      }
      if (source === 'results' || source === 'all') {
        detail.results = await resultScraper.scrape({ filters, maxPages, fetchDetails })
        accumulate(totals, detail.results)
      }

      detail.matching = await matcher.run()
      totals.matchesLinked = detail.matching.matchesLinked

      const finished = await jobs.finish(job.id, { status: 'success', stats: totals })
      log.info('job finished', { jobId: job.id, ...totals })
      return { job: finished, stats: totals, detail }
    } catch (error) {
      await jobs.finish(job.id, { status: 'failed', stats: totals, error: error.message })
      log.error('job failed', { jobId: job.id, message: error.message })
      throw error
    }
  }

  const accumulate = (totals, stats) => {
    totals.pagesScraped += stats.pagesScraped ?? 0
    totals.itemsFound += stats.itemsFound ?? 0
    totals.itemsCreated += stats.itemsCreated ?? 0
    totals.itemsUpdated += stats.itemsUpdated ?? 0
  }

  return { run, matcher, consultationScraper, resultScraper, http }
}
