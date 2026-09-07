import { parseBtpList } from './parsers/btpParser.js'
import { logger } from '../utils/logger.js'

const log = logger.child('[scraper:btp]')

/** The Ministry of Equipment, not the procurement portal. */
export const BTP_HOST = 'https://www.equipement.gov.ma'
export const BTP_PATH = '/ministere/E-Services/pages/liste-des-entreprises.aspx'

/**
 * ASP.NET control names. Stable identifiers in the page's own control tree, so
 * configuration rather than something to rediscover each run.
 */
const PREFIX = 'ctl00$ctl36$g_c22810fe_535a_45e2_9941_38d174e62f90$ctl00$'
const SEARCH_BUTTON = `${PREFIX}Rech_Btn`
const CRITERIA = `${PREFIX}D4`
const QUALIFICATION = `${PREFIX}T1`

/**
 * Eleven criteria selects, in the order the page lays them out: three
 * sector/class pairs joined by an operator, then region, province and city.
 * They all share one control name, so the server reads them as a list and order
 * is the only thing that tells them apart. Left at their defaults, the register
 * answers with every qualified company.
 */
const ALL_COMPANIES = [
  'Liste des secteurs', '0', 'Intersection',
  'Liste des secteurs', '0', 'Intersection',
  'Liste des secteurs', '0',
  'Toutes les Régions', 'Toutes les Provinces', 'Toutes les Villes',
]

const ROWS_PER_PAGE = 10

/**
 * The register of BTP companies qualified for public works.
 *
 * Worth the trouble because it carries what nothing else free and official
 * does: a trade-register number, a street address, a city and a telephone for
 * each company — none of which appears on an award row.
 *
 * Three shapes of request. Open the page for its view state; post the search,
 * whose button is an <input type="image"> and so submits click coordinates
 * rather than a value — posting `name=value` returns the empty form and looks
 * exactly like "no results"; then page through, carrying each response's view
 * state into the next request and picking the pager link whose label is the
 * page wanted, because the window of page numbers slides as you advance.
 */
export function createBtpScraper({ http, btp, maxPages = 600 }) {
  async function scrape({ startPage = 1, pages = maxPages } = {}) {
    const stats = { pagesScraped: 0, itemsFound: 0, itemsCreated: 0, itemsUpdated: 0, itemsUnchanged: 0, errors: [] }

    const form = await http.getHtml(BTP_HOST + BTP_PATH)
    let response = await http.postForm(BTP_HOST + BTP_PATH, null, {
      ...aspNetState(form.html),
      __EVENTTARGET: '',
      __EVENTARGUMENT: '',
      ...criteria(),
      // Click coordinates: this button is an image, not a submit.
      [`${SEARCH_BUTTON}.x`]: '12',
      [`${SEARCH_BUTTON}.y`]: '9',
    })

    let parsed = parseBtpList(response.html, response.url)
    const total = parsed.total
    const lastPage = total ? Math.ceil(total / ROWS_PER_PAGE) : null
    log.info('search done', { total, lastPage })

    let page = 1
    while (page < startPage && (lastPage === null || page < lastPage)) {
      ;({ response, parsed } = await turnTo(page + 1, response, parsed))
      page += 1
    }

    const stopAt = lastPage === null ? startPage + pages - 1 : Math.min(lastPage, startPage + pages - 1)
    while (true) {
      stats.pagesScraped += 1
      stats.itemsFound += parsed.items.length
      await store(parsed.items, stats)
      log.info('page parsed', { page, items: parsed.items.length, total })

      if (page >= stopAt) break
      const next = await turnTo(page + 1, response, parsed)
      if (!next) break
      ;({ response, parsed } = next)
      page += 1
    }

    return { ...stats, total, lastPage, nextPage: page + 1 }
  }

  /** Follows the pager link labelled with the wanted page number. */
  async function turnTo(wanted, previous, parsed) {
    const target = parsed.pager[String(wanted)]
    if (!target) {
      log.warn('no pager link for that page', { wanted, offered: Object.keys(parsed.pager) })
      return null
    }
    const response = await http.postForm(BTP_HOST + BTP_PATH, null, {
      ...aspNetState(previous.html),
      __EVENTTARGET: target,
      __EVENTARGUMENT: '',
    })
    return { response, parsed: parseBtpList(response.html, response.url) }
  }

  async function store(items, stats) {
    for (const record of items) {
      try {
        const { outcome } = await btp.upsert(record)
        stats[outcome === 'created' ? 'itemsCreated' : outcome === 'updated' ? 'itemsUpdated' : 'itemsUnchanged'] += 1
      } catch (error) {
        log.error('upsert failed', { raisonSociale: record.raison_sociale, message: error.message })
        stats.errors.push({ raisonSociale: record.raison_sociale, message: error.message })
      }
    }
  }

  const criteria = () => ({ [CRITERIA]: ALL_COMPANIES, [QUALIFICATION]: ['', '', ''] })

  return { scrape }
}

/**
 * The three hidden fields every ASP.NET postback must carry. Absent, the server
 * answers with a fresh empty form — which reads as "no results" rather than as
 * the rejection it is.
 */
function aspNetState(html) {
  const read = (name) => html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`))?.[1]
  const viewState = read('__VIEWSTATE')
  if (!viewState) throw new Error('__VIEWSTATE missing: the BTP register has changed shape')
  return {
    __VIEWSTATE: viewState,
    __VIEWSTATEGENERATOR: read('__VIEWSTATEGENERATOR') ?? '',
    __EVENTVALIDATION: read('__EVENTVALIDATION') ?? '',
  }
}
