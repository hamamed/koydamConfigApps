import * as cheerio from 'cheerio'
import { FIELD_SYNONYMS, LIST_CONTAINERS, ROW_SELECTORS, DETAIL_LINK_SELECTORS, PAGINATION_SELECTORS } from '../selectors.js'
import { clean, normalize, splitLabelled } from '../../utils/text.js'

/**
 * Generic, label-driven HTML extraction primitives shared by the consultation,
 * result and article parsers. Nothing in here knows about a specific page — it
 * only knows how to turn French labels into canonical field names.
 */

/** Synonyms sorted longest-first so "date de publication du resultat" beats "date de publication". */
const SYNONYM_INDEX = Object.entries(FIELD_SYNONYMS)
  .flatMap(([field, synonyms]) =>
    synonyms.map((synonym) => {
      const normalized = normalize(synonym)
      return { field, synonym: normalized, pattern: new RegExp(`(^|\\s)${normalized}(\\s|$)`) }
    }),
  )
  .sort((a, b) => b.synonym.length - a.synonym.length)

export function loadHtml(html) {
  return cheerio.load(html)
}

/**
 * Resolves a human label ("Date limite de remise des plis") to a canonical
 * field name ("dateLimite").
 *
 * Matching is whole-word only: a substring test would let short synonyms such as
 * "u" (unité) or "lot" swallow any label that merely contains those letters.
 * @returns {string|null}
 */
export function matchField(label) {
  const normalized = normalize(label).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  const hit = SYNONYM_INDEX.find(({ pattern }) => pattern.test(normalized))
  return hit ? hit.field : null
}

/** Returns the first selector in `candidates` that matches at least one node. */
export function firstMatch($, candidates, root = null) {
  for (const selector of candidates) {
    const found = root ? root.find(selector) : $(selector)
    if (found.length > 0) return found
  }
  return null
}

/** Locates the listing table: the first candidate table holding at least one data row. */
export function findListTable($) {
  for (const selector of LIST_CONTAINERS) {
    const tables = $(selector)
    for (let i = 0; i < tables.length; i += 1) {
      const table = tables.eq(i)
      if (findRows($, table).length > 0) return table
    }
  }
  return null
}

/** Returns the data rows of a table/container, excluding the header row. */
export function findRows($, container) {
  for (const selector of ROW_SELECTORS) {
    const rows = container.find(selector).filter((_, element) => $(element).find('td').length > 0)
    if (rows.length > 0) return rows
  }
  return $([])
}

/**
 * Maps each column index of a table to a canonical field name.
 * @returns {(string|null)[]} e.g. [null, 'reference', 'objet', 'acheteur']
 */
export function extractHeaderMap($, container) {
  const headerCells = container.find('thead th, thead td').length
    ? container.find('thead th, thead td')
    : container.find('tr').first().find('th')
  return headerCells.toArray().map((cell) => matchField($(cell).text()))
}

/**
 * Reads "Label : value" pairs out of a fragment. Handles the three layouts the
 * portal mixes: definition lists, label/value cell pairs, and single cells
 * containing "Label : value" text.
 * @returns {Record<string, string>} canonical field -> raw value
 */
export function extractLabelledFields($, root) {
  const fields = {}
  const assign = (label, value) => {
    const field = matchField(label)
    const cleaned = clean(value)
    if (field && cleaned && !fields[field]) fields[field] = cleaned
  }

  root.find('dl').each((_, list) => {
    const terms = $(list).find('dt')
    const definitions = $(list).find('dd')
    terms.each((index, term) => assign($(term).text(), definitions.eq(index).text()))
  })

  root.find('tr').each((_, row) => {
    const cells = $(row).children('th, td')
    if (cells.length === 2) assign(cells.eq(0).text(), cells.eq(1).text())
  })

  root.find('.field, .info-line, li, p, td, div').each((_, node) => {
    const element = $(node)
    if (element.children().length > 2) return
    const [label, value] = splitLabelled(element.text())
    if (label) assign(label, value)
  })

  return fields
}

/** Extracts a row's cells as canonical fields using the table header map. */
export function extractRowFields($, row, headerMap) {
  const fields = {}
  row.children('td, th').each((index, cell) => {
    const field = headerMap[index]
    const value = clean($(cell).text())
    if (field && value && !fields[field]) fields[field] = value
  })
  // Rows also frequently embed "Label : value" text inside a single wide cell.
  return { ...extractLabelledFields($, row), ...fields }
}

/** First detail-page link found inside a row, resolved against the page URL. */
export function extractDetailUrl($, row, pageUrl) {
  const link = firstMatch($, DETAIL_LINK_SELECTORS, row)
  const href = link?.attr('href')
  if (!href || href.startsWith('#') || href.startsWith('javascript:')) return null
  try {
    return new URL(href, pageUrl).toString()
  } catch {
    return null
  }
}

/**
 * Highest page number advertised by the pagination widget.
 * Falls back to 1 when the portal renders a single page of results.
 */
export function extractTotalPages($) {
  let maxPage = 1
  for (const selector of PAGINATION_SELECTORS) {
    $(selector).each((_, link) => {
      const href = $(link).attr('href') ?? ''
      const fromHref = Number.parseInt(new URLSearchParams(href.split('?')[1] ?? '').get('page') ?? '', 10)
      const fromText = Number.parseInt(clean($(link).text()), 10)
      maxPage = Math.max(maxPage, Number.isFinite(fromHref) ? fromHref : 1, Number.isFinite(fromText) ? fromText : 1)
    })
  }
  return maxPage
}

/** Reads the "N résultats" counter when the portal prints one. */
export function extractTotalCount($) {
  const text = clean($('body').text())
  const match = text.match(/(\d[\d\s]*)\s*(?:resultat|résultat|consultation|annonce)/i)
  if (!match) return null
  return Number.parseInt(match[1].replace(/\s/g, ''), 10)
}
