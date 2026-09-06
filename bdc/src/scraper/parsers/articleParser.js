import {
  ARTICLE_ITEM_SELECTORS,
  ARTICLE_HEADING_SELECTORS,
  ARTICLE_SPEC_SELECTORS,
} from '../selectors.js'
import { extractLabelledFields, firstMatch } from './listParser.js'
import { clean, cleanOrNull, normalizeReference } from '../../utils/text.js'
import { parseAmountToCentimes } from '../../utils/money.js'
import { nowIso } from '../../utils/dates.js'

const QUANTITY_PATTERN = /(\d+(?:[.,]\d+)?)/
const ARTICLE_NUMBER = /^#?\s*(\d+)/

const parseNumber = (value) => {
  const match = String(value ?? '').match(QUANTITY_PATTERN)
  return match ? Number.parseFloat(match[1].replace(',', '.')) : null
}

/**
 * Parses the article breakdown of a consultation detail page.
 *
 * Each article is a Bootstrap accordion item: the heading holds "#01" and the
 * designation, the panel holds the specification text and a mini-card of
 * labelled attributes (unit, quantity, VAT, required warranties).
 *
 * Note there is no unit price. These are calls for quotes — the supplier
 * proposes the price, which is exactly what the invoice generator supplies.
 * @returns {object[]} records ready for `consultation_articles`.
 */
export function parseArticles($, reference) {
  const items = firstMatch($, ARTICLE_ITEM_SELECTORS)
  if (!items) return []

  const articles = []
  items.each((index, element) => {
    const item = $(element)
    const heading = firstMatch($, ARTICLE_HEADING_SELECTORS, item)
    const headingText = clean(heading?.first().text())
    if (!headingText) return

    // "#01CÂBLE PNI avec brassard" — the number is its own span, so removing it
    // from the heading text leaves the designation.
    const numberSpan = clean(heading.first().find('span').first().text())
    const articleNumber = numberSpan.match(ARTICLE_NUMBER)?.[1] ?? String(index + 1)
    const designation = clean(headingText.replace(numberSpan, ''))
    if (!designation) return

    const fields = extractLabelledFields($, item)
    const description = specificationText($, item) ?? cleanOrNull(fields.description)

    articles.push(toArticleRecord({ ...fields, designation, articleNumber, description }, reference))
  })

  return articles.filter(Boolean)
}

/** The free-text specification block, which is not a "label: value" pair. */
function specificationText($, item) {
  const block = firstMatch($, ARTICLE_SPEC_SELECTORS, item)
  if (!block) return null
  // The label is the block's own text and the body sits in a nested span.
  const body = block.first().find('span').first()
  return cleanOrNull(body.length > 0 ? body.text() : block.first().text())
}

/**
 * Normalises raw article fields into a `consultation_articles` row.
 * @returns {object|null} null when the row carries no usable designation.
 */
export function toArticleRecord(fields, reference) {
  const designation = cleanOrNull(fields.designation)
  if (!designation) return null

  const timestamp = nowIso()
  return {
    consultation_reference: normalizeReference(reference),
    lot_number: cleanOrNull(fields.lotNumber),
    article_number: cleanOrNull(fields.articleNumber),
    designation,
    description: cleanOrNull(fields.description),
    categorie: cleanOrNull(fields.categorie),
    quantity: parseNumber(fields.quantity),
    unit: cleanOrNull(fields.unit),
    unit_price_cents: parseAmountToCentimes(fields.unitPrice),
    estimation_cents: parseAmountToCentimes(fields.estimation),
    caution_cents: parseAmountToCentimes(fields.cautionProvisoire),
    tva_rate: parseNumber(fields.tvaRate),
    garanties: cleanOrNull(fields.garanties),
    delai_execution: cleanOrNull(fields.delaiExecution),
    lieu_execution: cleanOrNull(fields.lieuExecution),
    raw_json: JSON.stringify(fields),
    created_at: timestamp,
    updated_at: timestamp,
  }
}
