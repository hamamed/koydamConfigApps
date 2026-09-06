import { config } from '../config/index.js'
import { buildSearchQuery } from './selectors.js'
import { parseConsultationList, parseConsultationDetail } from './parsers/consultationParser.js'
import { mapWithConcurrency } from '../utils/concurrency.js'
import { nowIso } from '../utils/dates.js'
import { logger } from '../utils/logger.js'

const log = logger.child('[scraper:consultations]')

/**
 * Crawls the open-consultations listing at
 * `/bdc/entreprise/consultation/`, persisting every row and — when enabled —
 * the full article/lot breakdown from each detail page.
 */
export function createConsultationScraper({ http, consultations, articles }) {
  /**
   * @param {object} options
   * @param {object} [options.filters] portal search filters to narrow the crawl.
   * @param {number} [options.maxPages] hard cap on pagination.
   * @param {boolean} [options.fetchDetails] also crawl each detail page.
   * @returns {Promise<{pagesScraped, itemsFound, itemsCreated, itemsUpdated, itemsUnchanged, articlesSaved, errors}>}
   */
  async function scrape(options = {}) {
    const {
      filters = {},
      maxPages = config.scraper.maxPages,
      fetchDetails = config.scraper.fetchDetails,
      onProgress = () => {},
    } = options

    const stats = {
      pagesScraped: 0,
      itemsFound: 0,
      itemsCreated: 0,
      itemsUpdated: 0,
      itemsUnchanged: 0,
      articlesSaved: 0,
      errors: [],
    }

    let page = 1
    let totalPages = 1

    while (page <= Math.min(totalPages, maxPages)) {
      const query = buildSearchQuery(filters, { page, pageSize: config.scraper.pageSize })
      const { html, url } = await http.getHtml(config.scraper.consultationsPath, query)
      const parsed = parseConsultationList(html, url)

      totalPages = Math.max(totalPages, parsed.totalPages)
      stats.pagesScraped += 1
      stats.itemsFound += parsed.items.length
      log.info('page parsed', { page, totalPages, items: parsed.items.length })

      const saved = []
      for (const record of parsed.items) {
        try {
          const { row, outcome } = await consultations.upsert(record)
          stats[outcome === 'created' ? 'itemsCreated' : outcome === 'updated' ? 'itemsUpdated' : 'itemsUnchanged'] += 1
          saved.push({ row, record, outcome })
        } catch (error) {
          log.error('upsert failed', { reference: record.reference, message: error.message })
          stats.errors.push({ reference: record.reference, message: error.message })
        }
      }

      if (fetchDetails) {
        stats.articlesSaved += await scrapeDetails(saved, stats)
      }

      onProgress({ page, totalPages, stats })

      // An empty page means the portal ran out of results before `totalPages`.
      if (parsed.items.length === 0) break
      page += 1
    }

    return stats
  }

  /** Fetches the detail page of freshly seen consultations and stores their lots. */
  async function scrapeDetails(saved, stats) {
    const targets = saved.filter(({ row, outcome }) => row?.detail_url && outcome !== 'unchanged')
    if (targets.length === 0) return 0

    let articlesSaved = 0
    const outcomes = await mapWithConcurrency(
      targets,
      async ({ row }) => {
        const { html, url } = await http.getHtml(row.detail_url)
        const detail = parseConsultationDetail(html, url, row.reference)
        if (detail.consultation) {
          await consultations.upsert({ ...detail.consultation, source_id: row.source_id }, { fromDetail: true })
        }
        if (detail.articles.length > 0) {
          const stored = await articles.replaceForConsultation(row.id, detail.articles)
          return stored.length
        }
        return 0
      },
      config.scraper.detailConcurrency,
    )

    for (const outcome of outcomes) {
      if (outcome.error) {
        log.warn('detail fetch failed', { reference: outcome.item.row.reference, message: outcome.error.message })
        stats.errors.push({ reference: outcome.item.row.reference, message: outcome.error.message })
        continue
      }
      articlesSaved += outcome.value
    }
    return articlesSaved
  }

  /** Re-crawls the detail page of a single consultation, on demand from the admin panel. */
  async function scrapeDetail(consultation) {
    if (!consultation.detail_url) return { articles: [] }
    const { html, url } = await http.getHtml(consultation.detail_url)
    const detail = parseConsultationDetail(html, url, consultation.reference)
    if (detail.consultation) {
      await consultations.upsert({ ...detail.consultation, source_id: consultation.source_id }, { fromDetail: true })
    }
    const stored = detail.articles.length
      ? await articles.replaceForConsultation(consultation.id, detail.articles)
      : []
    return { articles: stored }
  }

  /**
   * Reads the detail page of every consultation that has never had one read.
   *
   * A crawl only follows the detail page of rows it just created or changed, so
   * anything seen before this feature existed — or skipped because a page 404'd
   * that day — keeps its listing-only half-record: no category, no nature of
   * service, no articles. This walks the backlog until it is empty.
   *
   * @param {{limit?: number, batchSize?: number, onProgress?: Function}} options
   *   `limit` caps the total pages fetched in one run, so a backfill of tens of
   *   thousands of rows can be done in sittings instead of one very long crawl.
   */
  async function backfillDetails(options = {}) {
    const { limit = Infinity, batchSize = 100, onProgress = () => {} } = options
    const stats = { consultationsProcessed: 0, articlesSaved: 0, pagesScraped: 0, errors: [] }

    while (stats.consultationsProcessed < limit) {
      const remaining = limit - stats.consultationsProcessed
      const pending = await consultations.listPendingDetails(Math.min(batchSize, remaining))
      if (pending.length === 0) break

      const outcomes = await mapWithConcurrency(
        pending,
        async (row) => (await scrapeDetail(row)).articles.length,
        config.scraper.detailConcurrency,
      )

      for (const outcome of outcomes) {
        stats.consultationsProcessed += 1
        stats.pagesScraped += 1
        if (outcome.error) {
          log.warn('backfill failed', { reference: outcome.item.reference, message: outcome.error.message })
          stats.errors.push({ reference: outcome.item.reference, message: outcome.error.message })
          // Stamp it so a permanently broken page cannot stall the queue forever.
          await consultations.update(outcome.item.id, { detail_scraped_at: nowIso() })
          continue
        }
        stats.articlesSaved += outcome.value
      }

      onProgress({ processed: stats.consultationsProcessed, remaining: await consultations.countPendingDetails() })
      log.info('backfill batch', { processed: stats.consultationsProcessed, articles: stats.articlesSaved })
    }

    return stats
  }

  return { scrape, scrapeDetail, backfillDetails }
}
