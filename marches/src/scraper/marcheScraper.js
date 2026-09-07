import { config } from '../config/index.js'
import { parseMarcheList, parseMarcheDetail, parseFormState, POSTBACK } from './parsers/marcheParser.js'
import { mapWithConcurrency } from '../utils/concurrency.js'
import { nowIso } from '../utils/dates.js'
import { logger } from '../utils/logger.js'

const log = logger.child('[scraper:marches]')

/**
 * Crawls the appel d'offres listing on marchespublics.gov.ma.
 *
 * The listing is a PRADO form, so there is no page query parameter: every page
 * after the first is a postback that echoes the whole hidden form state back,
 * `PRADO_PAGESTATE` above all. Two postbacks matter —
 *
 *   1. set the page size to 500, which the portal offers and which turns a
 *      201-page crawl of 100k consultations into something a timer can run;
 *   2. "page suivante", which is the only control that actually advances.
 *      Posting `numPageTop` alone looks like it should work and silently
 *      returns page one again, which is how a crawl can appear to run and
 *      store the same 500 rows all night.
 *
 * Rows come back ordered by closing date descending, so the consultations still
 * open lead and the ones closing soonest sit at the *end* of that run. Stopping
 * early therefore drops the most urgent marchés, not the least interesting —
 * the same trap that once cost the bons de commande crawl every avis closing
 * inside a day. `until` decides where to stop, and defaults to the whole of the
 * open window rather than a page count.
 */
export function createMarcheScraper({ http, consultations, settings }) {
  const knobs = async () => (settings ? { ...config.scraper, ...(await settings.section('scraper')) } : config.scraper)

  const LISTING_PATH = '/index.php?page=entreprise.EntrepriseAdvancedSearch&AllCons'
  const PAGE_SIZE = '500'

  /**
   * @param {object} options
   * @param {(row: object) => boolean} [options.until] called with each parsed
   *   row; returning true stops the crawl after the page it appears on.
   *   Defaults to "the deadline has passed", i.e. crawl the open window.
   * @param {number} [options.maxPages] hard ceiling, so a parser regression
   *   cannot walk all 201 pages.
   * @param {boolean} [options.fetchDetails] also fetch each detail page, which
   *   is where the estimate lives.
   */
  async function scrape(options = {}) {
    const runtime = await knobs()
    const {
      until = (row) => Boolean(row.date_limite) && row.date_limite < today(),
      maxPages = 20,
      fetchDetails = true,
      onProgress = () => {},
    } = options

    const stats = {
      pagesScraped: 0,
      itemsFound: 0,
      itemsCreated: 0,
      itemsUpdated: 0,
      itemsUnchanged: 0,
      detailsFetched: 0,
      estimatesFound: 0,
      total: null,
      errors: [],
    }

    // The seed GET is what hands out the session cookie and the first
    // PRADO_PAGESTATE; every postback below is answered relative to it.
    const seed = await http.getHtml(LISTING_PATH)
    let state = parseFormState(seed.html)

    let html = await postback(state, POSTBACK.pageSize, {
      [POSTBACK.pageSize]: PAGE_SIZE,
      'ctl0$CONTENU_PAGE$resultSearch$listePageSizeBottom': PAGE_SIZE,
    })

    for (let page = 1; page <= maxPages; page += 1) {
      const parsed = parseMarcheList(html)
      stats.total ??= parsed.total
      stats.pagesScraped += 1
      stats.itemsFound += parsed.items.length
      log.info('page parsed', { page, items: parsed.items.length, total: parsed.total })

      if (parsed.items.length === 0) break

      const saved = await persist(parsed.items, stats)
      if (fetchDetails) await withDetails(saved, runtime, stats)
      onProgress({ ...stats, page })

      if (parsed.items.some(until)) {
        log.info('reached the end of the requested window', { page })
        break
      }

      state = parseFormState(html)
      html = await postback(state, POSTBACK.next)
    }

    return stats
  }

  /**
   * One PRADO postback: the page's own hidden state, plus which control fired.
   * The page size is re-sent every time — it lives in the form, and a postback
   * that omits it silently reverts the listing to ten rows a page.
   */
  async function postback(state, target, extra = {}) {
    const body = {
      ...state,
      PRADO_POSTBACK_TARGET: target,
      PRADO_POSTBACK_PARAMETER: '',
      [POSTBACK.pageSize]: PAGE_SIZE,
      'ctl0$CONTENU_PAGE$resultSearch$listePageSizeBottom': PAGE_SIZE,
      ...extra,
    }
    const { html } = await http.postForm(LISTING_PATH, null, body)
    return html
  }

  /** Upserts a page of rows, counting what actually changed. */
  async function persist(items, stats) {
    const saved = []
    for (const item of items) {
      try {
        const { row, outcome } = await consultations.upsert({ ...item, last_seen_at: nowIso() })
        stats[COUNTER[outcome] ?? 'itemsUnchanged'] += 1
        saved.push(row)
      } catch (error) {
        stats.errors.push({ source_id: item.source_id, message: error.message })
      }
    }
    return saved
  }

  /**
   * Fetches the detail page of every row still missing an estimate.
   *
   * The estimate is the reason this crawler exists — it is the input article 44
   * computes every threshold from, and the listing does not carry it. The page
   * needs no session, so this is a plain throttled GET per consultation.
   */
  async function withDetails(rows, runtime, stats) {
    const pending = rows.filter((row) => row && row.estimation_cents === null && row.detail_url)
    if (pending.length === 0) return

    await mapWithConcurrency(pending, async (row) => {
      try {
        const { html } = await http.getHtml(row.detail_url)
        // Only the columns: the parser also reports whether the commission
        // block was present, which is diagnostic rather than data.
        const { estimation_cents, qualifications } = parseMarcheDetail(html)
        await consultations.update(row.id, {
          estimation_cents,
          qualification: qualifications,
          detail_scraped_at: nowIso(),
        })
        stats.detailsFetched += 1
        if (estimation_cents !== null) stats.estimatesFound += 1
      } catch (error) {
        stats.errors.push({ source_id: row.source_id, message: error.message })
      }
    }, runtime.concurrency ?? 2)
  }

  return { scrape, scrapeDetail: withDetails }
}

const COUNTER = { created: 'itemsCreated', updated: 'itemsUpdated', unchanged: 'itemsUnchanged' }

/** Today in the portal's own terms — dates here are plain ISO days. */
const today = () => nowIso().slice(0, 10)
