import { config } from '../config/index.js'
import { buildSearchQuery } from './selectors.js'
import { parseResultList, parseResultDetail } from './parsers/resultParser.js'
import { mapWithConcurrency } from '../utils/concurrency.js'
import { logger } from '../utils/logger.js'

const log = logger.child('[scraper:results]')

/** In a row, not in total: this many means the portal is down, not merely flaky. */
const MAX_CONSECUTIVE_FAILURES = 5

/**
 * Crawls the awards listing at `/bdc/entreprise/consultation/resultat`.
 *
 * Results are stored independently of consultations — a result may be published
 * for a consultation this instance never saw. The `reference` column is what
 * links the two datasets afterwards (see matcher.js).
 */
export function createResultScraper({ http, results, settings }) {
  const knobs = async () => (settings ? { ...config.scraper, ...(await settings.section('scraper')) } : config.scraper)

  async function scrape(options = {}) {
    const runtime = await knobs()
    const {
      filters = {},
      maxPages = runtime.maxPages,
      fetchDetails = runtime.fetchDetails,
      pageSize = runtime.pageSize,
      // Archival passes step over a page that will not load; a daily crawl
      // fails loudly instead, because there the missing page is the news.
      skipFailedPages = false,
      // Where to begin. A deep archival pass over six thousand pages will meet a
      // dropped connection eventually, and without this the only way to continue
      // was to re-crawl every page already read — 290 of them, the first time it
      // happened. The listing is newest-first and stable enough for this: a page
      // number means the same rows on the next run.
      startPage = 1,
      onProgress = () => {},
    } = options

    const stats = {
      pagesScraped: 0,
      itemsFound: 0,
      itemsCreated: 0,
      itemsUpdated: 0,
      itemsUnchanged: 0,
      lotsSaved: 0,
      pagesFailed: [],
      errors: [],
    }

    let page = Math.max(1, startPage)
    let totalPages = page
    const lastPage = page + maxPages - 1

    let consecutiveFailures = 0

    while (page <= Math.min(totalPages, lastPage)) {
      const query = buildSearchQuery('results', filters, { page, pageSize })

      let html
      let url
      try {
        ;({ html, url } = await http.getHtml(config.scraper.resultsPath, query))
        consecutiveFailures = 0
      } catch (error) {
        // A single page that will not load must not end a pass over thousands.
        // The archive crawl met exactly this at page 292 of 1500 and threw away
        // 290 pages of work; the portal was answering again minutes later.
        // Failures in a row are different — that is the portal down or refusing
        // us, and hammering it further is neither useful nor polite.
        consecutiveFailures += 1
        stats.pagesFailed.push(page)
        log.warn('page failed, continuing', { page, consecutiveFailures, reason: error.message })
        if (!skipFailedPages || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) throw error
        page += 1
        continue
      }

      const parsed = parseResultList(html, url)

      totalPages = Math.max(totalPages, parsed.totalPages)
      stats.totalPages = totalPages
      stats.pagesScraped += 1
      stats.itemsFound += parsed.items.length
      log.info('page parsed', { page, totalPages, items: parsed.items.length })

      const saved = []
      for (const record of parsed.items) {
        try {
          const { row, outcome } = await results.upsert(record)
          stats[outcome === 'created' ? 'itemsCreated' : outcome === 'updated' ? 'itemsUpdated' : 'itemsUnchanged'] += 1
          saved.push({ row, outcome })
        } catch (error) {
          log.error('upsert failed', { reference: record.reference, message: error.message })
          stats.errors.push({ reference: record.reference, message: error.message })
        }
      }

      if (fetchDetails) {
        stats.lotsSaved += await scrapeDetails(saved, stats, runtime.detailConcurrency)
      }

      onProgress({ page, totalPages, stats })
      if (parsed.items.length === 0) break
      page += 1
    }

    return stats
  }

  async function scrapeDetails(saved, stats, concurrency) {
    const targets = saved.filter(({ row, outcome }) => row?.detail_url && outcome !== 'unchanged')
    if (targets.length === 0) return 0

    let lotsSaved = 0
    const outcomes = await mapWithConcurrency(
      targets,
      async ({ row }) => {
        const { html, url } = await http.getHtml(row.detail_url)
        const detail = parseResultDetail(html, url, row.reference)
        if (detail.result) {
          await results.upsert({ ...detail.result, result_key: row.result_key })
        }
        if (detail.lots.length === 0) return 0
        const stored = await results.replaceLots(row.id, detail.lots)
        return stored.length
      },
      concurrency,
    )

    for (const outcome of outcomes) {
      if (outcome.error) {
        log.warn('detail fetch failed', { reference: outcome.item.row.reference, message: outcome.error.message })
        stats.errors.push({ reference: outcome.item.row.reference, message: outcome.error.message })
        continue
      }
      lotsSaved += outcome.value
    }
    return lotsSaved
  }

  return { scrape }
}
