import { ARTICLE_TABLE_SELECTORS } from '../selectors.js'
import { extractHeaderMap, extractLabelledFields, findRows, matchField } from './listParser.js'
import { cleanOrNull, normalizeReference } from '../../utils/text.js'
import { parseAmountToCentimes } from '../../utils/money.js'
import { nowIso } from '../../utils/dates.js'

const QUANTITY_PATTERN = /(\d+(?:[.,]\d+)?)/

const parseQuantity = (value) => {
  const match = String(value ?? '').match(QUANTITY_PATTERN)
  return match ? Number.parseFloat(match[1].replace(',', '.')) : null
}

/** A lot/article table is only interesting if it exposes a designation-like column. */
const looksLikeArticleTable = ($, table) => {
  const headers = table.find('th').toArray().map((cell) => matchField($(cell).text()))
  return headers.some((field) => ['designation', 'lotNumber', 'articleNumber', 'quantity'].includes(field))
}

/**
 * Parses the article / lot breakdown of a consultation detail page.
 *
 * The portal renders lots either as a dedicated table or as repeated
 * "Lot n° X" blocks; both shapes are handled.
 * @returns {object[]} article records ready for `consultation_articles`.
 */
export function parseArticles($, reference) {
  const rows = []

  for (const selector of ARTICLE_TABLE_SELECTORS) {
    const tables = $(selector)
    for (let i = 0; i < tables.length; i += 1) {
      const table = tables.eq(i)
      if (!looksLikeArticleTable($, table)) continue
      const headerMap = extractHeaderMap($, table)
      findRows($, table).each((_, element) => {
        const row = $(element)
        const fields = {}
        row.children('td, th').each((index, cell) => {
          const field = headerMap[index]
          if (field) fields[field] = $(cell).text()
        })
        const record = toArticleRecord(fields, reference)
        if (record) rows.push(record)
      })
      if (rows.length > 0) return dedupe(rows)
    }
  }

  // Fallback: "Lot n° 1 — ..." blocks rendered as cards.
  $('[class*="lot"], [id*="lot"]').each((_, element) => {
    const block = $(element)
    if (block.find('[class*="lot"]').length > 0) return
    const fields = extractLabelledFields($, block)
    const record = toArticleRecord(fields, reference)
    if (record) rows.push(record)
  })

  return dedupe(rows)
}

/**
 * Normalises raw article fields into a `consultation_articles` row.
 * @returns {object|null} null when the row carries no usable designation.
 */
export function toArticleRecord(fields, reference) {
  const designation = cleanOrNull(fields.designation ?? fields.objet ?? fields.description)
  if (!designation) return null

  const timestamp = nowIso()
  return {
    consultation_reference: normalizeReference(reference),
    lot_number: cleanOrNull(fields.lotNumber),
    article_number: cleanOrNull(fields.articleNumber),
    designation,
    description: cleanOrNull(fields.description),
    categorie: cleanOrNull(fields.categorie),
    quantity: parseQuantity(fields.quantity),
    unit: cleanOrNull(fields.unit),
    unit_price_cents: parseAmountToCentimes(fields.unitPrice),
    estimation_cents: parseAmountToCentimes(fields.estimation),
    caution_cents: parseAmountToCentimes(fields.cautionProvisoire),
    delai_execution: cleanOrNull(fields.delaiExecution),
    lieu_execution: cleanOrNull(fields.lieuExecution),
    raw_json: JSON.stringify(fields),
    created_at: timestamp,
    updated_at: timestamp,
  }
}

/** Guards against the same lot being picked up by two selector candidates. */
function dedupe(records) {
  const seen = new Set()
  return records.filter((record) => {
    const key = `${record.lot_number ?? ''}|${record.article_number ?? ''}|${record.designation}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
