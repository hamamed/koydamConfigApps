import { parseExclusionList } from './parsers/exclusionParser.js'
import { identityKey } from '../repositories/exclusionRepository.js'
import { logger } from '../utils/logger.js'

const log = logger.child('[scraper:exclusions]')

/** The main portal, not the /bdc sub-portal the avis come from. */
export const EXCLUSIONS_PATH = '/index.php'
const EXCLUSIONS_QUERY = { page: 'entreprise.EntrepriseRechercherSocietesExclues', search: '1' }

/**
 * PRADO control names. They are stable identifiers in the page's own component
 * tree, not generated per request, so they are configuration rather than
 * something to rediscover on every run.
 */
const SEARCH_BUTTON = 'ctl0$CONTENU_PAGE$tableauRechercheSocietesExclues$ctl30'
const PAGE_SIZE_FIELD = 'ctl0$CONTENU_PAGE$tableauAffichageSocietesExclues$nbResultsTop'
const PAGE_FIELD = 'ctl0$CONTENU_PAGE$tableauAffichageSocietesExclues$pageNumberTop'
/** The largest the portal's own selector offers; the whole list fits inside it. */
const PAGE_SIZE = 500

/**
 * The official register of companies excluded from public procurement.
 *
 * This page is a PRADO form, not a query string: results come from posting the
 * page's own view state back to it. Three requests fetch the whole list —
 * open the form, run the search, then re-post asking for 500 rows a page. There
 * were 290 exclusions in total when this was written, so there is no paging
 * loop to get wrong; if the list ever outgrows one page the total reported by
 * the portal will no longer match what was parsed, and the run says so.
 */
export function createExclusionScraper({ http, exclusions }) {
  async function scrape() {
    const stats = { pagesScraped: 0, itemsFound: 0, itemsCreated: 0, itemsUpdated: 0, itemsUnchanged: 0, itemsCollapsed: 0, errors: [] }

    const form = await http.getHtml(EXCLUSIONS_PATH, EXCLUSIONS_QUERY)
    const searched = await http.postForm(EXCLUSIONS_PATH, EXCLUSIONS_QUERY, {
      PRADO_PAGESTATE: readPageState(form.html),
      PRADO_POSTBACK_TARGET: SEARCH_BUTTON,
      [SEARCH_BUTTON]: 'Lancer la recherche',
    })

    const all = await http.postForm(EXCLUSIONS_PATH, EXCLUSIONS_QUERY, {
      PRADO_PAGESTATE: readPageState(searched.html),
      PRADO_POSTBACK_TARGET: PAGE_SIZE_FIELD,
      [PAGE_SIZE_FIELD]: String(PAGE_SIZE),
      [PAGE_FIELD]: '1',
    })

    stats.pagesScraped = 1
    const { items, total } = parseExclusionList(all.html, all.url)
    stats.itemsFound = items.length
    log.info('list parsed', { parsed: items.length, portalTotal: total })

    // The portal states its own count. A parse that returns fewer has lost rows
    // — the failure this crawler would otherwise report as success.
    if (total !== null && items.length < total) {
      stats.errors.push({ message: `parsed ${items.length} of ${total} exclusions` })
      log.warn('incomplete list', { parsed: items.length, portalTotal: total })
    }

    const seen = new Set()
    for (const record of items) {
      // The portal lists the same exclusion twice when two decision documents
      // are attached to it. The rows are identical but for the document id, so
      // storing both means each run overwrites the last one's — a list that
      // never changes would report changes forever. First one wins.
      const key = identityKey(record)
      if (seen.has(key)) {
        stats.itemsCollapsed += 1
        continue
      }
      seen.add(key)

      try {
        const { outcome } = await exclusions.upsert(record)
        stats[outcome === 'created' ? 'itemsCreated' : outcome === 'updated' ? 'itemsUpdated' : 'itemsUnchanged'] += 1
      } catch (error) {
        log.error('upsert failed', { raisonSociale: record.raison_sociale, message: error.message })
        stats.errors.push({ raisonSociale: record.raison_sociale, message: error.message })
      }
    }

    log.info('done', stats)
    return { ...stats, portalTotal: total }
  }

  return { scrape }
}

/**
 * PRADO carries the whole server-side control tree in this field, and refuses a
 * postback without it. Absent, the page has changed shape and guessing would
 * produce an empty list that looks like "no exclusions today".
 */
function readPageState(html) {
  const match = html.match(/name="PRADO_PAGESTATE"[^>]*value="([^"]*)"/)
  if (!match) throw new Error('PRADO_PAGESTATE missing: the exclusions form has changed shape')
  return match[1]
}
