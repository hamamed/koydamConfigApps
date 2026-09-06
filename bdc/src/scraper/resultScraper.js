import { config } from '../config/index.js'
import { buildSearchQuery } from './selectors.js'
import { parseResultList, parseResultDetail } from './parsers/resultParser.js'
import { mapWithConcurrency } from '../utils/concurrency.js'
import { logger } from '../utils/logger.js'

const log = logger.child('[scraper:results]')

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
      onProgress = () => {},
    } = options

    const stats = {
      pagesScraped: 0,
      itemsFound: 0,
      itemsCreated: 0,
      itemsUpdated: 0,
      itemsUnchanged: 0,
      lotsSaved: 0,
      errors: [],
    }

    let page = 1
    let totalPages = 1

    while (page <= Math.min(totalPages, maxPages)) {
      const query = buildSearchQuery(filters, { page, pageSize: runtime.pageSize })
      const { html, url } = await http.getHtml(config.scraper.resultsPath, query)
      const parsed = parseResultList(html, url)

      totalPages = Math.max(totalPages, parsed.totalPages)
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
