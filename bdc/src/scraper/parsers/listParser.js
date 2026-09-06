import * as cheerio from 'cheerio'
import {
  FIELD_SYNONYMS,
  ROW_SELECTORS,
  DETAIL_LINK_SELECTORS,
  PAGINATION_SELECTORS,
  STATUS_BADGE_SELECTORS,
} from '../selectors.js'
import { clean, normalize, splitLabelled } from '../../utils/text.js'

/**
 * Generic, label-driven HTML extraction primitives shared by the consultation,
 * result and article parsers. Nothing here knows about a specific page — it only
 * knows how to turn a French label into a canonical field name.
 *
 * The portal prints a label next to its value in three different shapes, and all
 * three appear on the same page:
 *
 *   1. inline    <div><span>Acheteur :</span> COMMUNE MAGHRAOUA</div>
 *   2. siblings  <span>Lieu d'exécution</span><span>AL HOCEIMA</span>
 *   3. wrapped   <div>Caractéristiques et spécifications <span>…</span></div>
 *
 * `extractLabelledFields` runs all three and merges the result.
 */

/** Synonyms sorted longest-first so "date de publication du resultat" beats "date de publication". */
const SYNONYM_INDEX = Object.entries(FIELD_SYNONYMS)
  .flatMap(([field, synonyms]) => synonyms.map((synonym) => ({ field, synonym: normalize(synonym) })))
  .sort((a, b) => b.synonym.length - a.synonym.length)

/**
 * How much longer than its synonym a label may be and still be a label.
 *
 * A value can quote its own field name — the cancellation motive on a real avis
 * reads "changement de la date limite pour la réception des devis", which
 * contains "date limite". Treating that sentence as a label made the parser walk
 * past it and store the *next* block ("Pièce jointe : Télécharger") as the
 * deadline. Labels lead with their name and are short; sentences are neither.
 */
const LABEL_SLACK_CHARS = 8
const LABEL_SLACK_FACTOR = 2

const TRAILING_COLON = /\s*:\s*$/

export function loadHtml(html) {
  return cheerio.load(html)
}

/**
 * Resolves a human label ("Date limite de réception des devis") to a canonical
 * field name ("dateLimite").
 *
 * Matching is whole-word only: a substring test would let short synonyms such as
 * "tva" or "lot" swallow any label that merely contains those letters.
 * @returns {string|null}
 */
export function matchField(label) {
  const normalized = normalize(label)
    .replace(TRAILING_COLON, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return null
  const hit = SYNONYM_INDEX.find(
    ({ synonym }) =>
      normalized === synonym ||
      (normalized.startsWith(`${synonym} `) &&
        normalized.length <= synonym.length * LABEL_SLACK_FACTOR + LABEL_SLACK_CHARS),
  )
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

/** The listing rows of a page — the portal renders both listings as cards. */
export function findRows($, root = null) {
  return firstMatch($, ROW_SELECTORS, root) ?? $([])
}

/** Text of an element excluding any nested element's text. */
function ownText($, element) {
  return clean(
    element
      .contents()
      .filter((_, node) => node.type === 'text')
      .text(),
  )
}

/**
 * Shape 1 — "Label : value" inside one element.
 * The colon may sit in a nested `<span>`; the parent's flattened text still
 * reads "Acheteur : COMMUNE MAGHRAOUA", which is what this splits.
 */
function collectInline($, root, assign) {
  root.find('a, div, li, p, span, dd, td').each((_, node) => {
    const element = $(node)
    // Skip containers. Their flattened text concatenates several fields, and
    // splitting that on the first colon invents a label out of two unrelated
    // values. One child is the normal shape here — <span>Label :</span> value.
    if (element.find('a, div, li, p').length > 0) return
    if (element.children().length > 1) return
    const [label, value] = splitLabelled(element.text())
    if (label) assign(matchField(label), value)
  })
}

/**
 * Shape 2 — label and value are sibling elements, with no colon between them.
 */
function collectSiblings($, root, assign) {
  root.find('span, dt, div, td, strong, b').each((_, node) => {
    const element = $(node)
    if (element.children().length > 0) return
    const field = matchField(element.text())
    if (!field) return

    // The cancellation block puts the label and its value in two different grid
    // columns, so when the label has no useful sibling of its own the value is
    // in the wrapper that follows the label's wrapper.
    const value = valueFromSiblings($, element) || valueFromSiblings($, element.parent())
    assign(field, value)
  })
}

/**
 * Reads a value out of the elements following `element`.
 *
 * The first following sibling is always taken, even when its own text happens to
 * look like a label: "Unité de mesure" is followed by the value "unité", which
 * would otherwise be read as another label and drop the field. Later siblings
 * are appended only while they are not labels, which is what joins a date and
 * its time into "16/03/2027 14:00".
 */
function valueFromSiblings($, element) {
  const parts = []
  element.nextAll().each((index, sibling) => {
    const text = clean($(sibling).text())
    if (!text) return undefined
    if (index > 0 && matchField(text)) return false
    parts.push(text)
    return undefined
  })
  return parts.join(' ')
}

/** Shape 3 — the label is the element's own text and the value is its only child. */
function collectWrapped($, root, assign) {
  root.find('div, p, li, td').each((_, node) => {
    const element = $(node)
    if (element.children().length !== 1) return
    assign(matchField(ownText($, element)), element.children().first().text())
  })
}

/**
 * Reads every "label -> value" pair out of a fragment, in all three shapes.
 * First value wins, so the most specific block on a page takes precedence.
 * @returns {Record<string, string>} canonical field -> raw value
 */
export function extractLabelledFields($, root) {
  const fields = {}
  const assign = (field, value) => {
    const cleaned = clean(value)
    if (field && cleaned && !fields[field]) fields[field] = cleaned
  }

  collectInline($, root, assign)
  collectSiblings($, root, assign)
  collectWrapped($, root, assign)
  return fields
}

/** Status pill printed on a card or a detail header ("Annulé"). */
export function extractStatusBadge($, root) {
  const badge = firstMatch($, STATUS_BADGE_SELECTORS, root)
  return badge ? clean(badge.first().text()) : null
}

/** First detail-page link inside a row, resolved against the page URL. */
export function extractDetailUrl($, row, pageUrl) {
  const link = firstMatch($, DETAIL_LINK_SELECTORS, row)
  const href = link?.first().attr('href')
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
      const query = href.includes('?') ? href.slice(href.indexOf('?') + 1) : ''
      const fromHref = Number.parseInt(new URLSearchParams(query).get('page') ?? '', 10)
      const fromText = Number.parseInt(clean($(link).text()), 10)
      maxPage = Math.max(maxPage, Number.isFinite(fromHref) ? fromHref : 1, Number.isFinite(fromText) ? fromText : 1)
    })
  }
  return maxPage
}

/** Reads the "N résultats" counter when the portal prints one. */
export function extractTotalCount($) {
  const text = clean($('body').text())
  const match = text.match(/(\d[\d\s]*)\s*(?:resultat|résultat|consultation|annonce|avis)/i)
  if (!match) return null
  return Number.parseInt(match[1].replace(/\s/g, ''), 10)
}
