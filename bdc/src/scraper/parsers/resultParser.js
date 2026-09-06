import {
  extractDetailUrl,
  extractHeaderMap,
  extractLabelledFields,
  extractRowFields,
  extractTotalCount,
  extractTotalPages,
  findListTable,
  findRows,
  loadHtml,
} from './listParser.js'
import { buildSearchText } from './consultationParser.js'
import { clean, cleanOrNull, extractReference, normalizeReference } from '../../utils/text.js'
import { parseDate, nowIso } from '../../utils/dates.js'
import { parseAmountToCentimes } from '../../utils/money.js'
import { config } from '../../config/index.js'

const AWARDED = /attribu/i
const CANCELLED = /annul/i
const UNSUCCESSFUL = /infructueu/i

/** Maps the portal's free-text status onto a stable enum. */
export function normalizeResultStatus(value) {
  const text = clean(value)
  if (!text) return null
  if (UNSUCCESSFUL.test(text)) return 'infructueux'
  if (CANCELLED.test(text)) return 'annule'
  if (AWARDED.test(text)) return 'attribue'
  return 'publie'
}

/**
 * Parses a page of the awards / results listing.
 * @returns {{items: object[], totalPages: number, totalCount: number|null}}
 */
export function parseResultList(html, pageUrl) {
  const $ = loadHtml(html)
  const table = findListTable($)
  const items = []

  if (table) {
    const headerMap = extractHeaderMap($, table)
    findRows($, table).each((_, element) => {
      const row = $(element)
      const fields = extractRowFields($, row, headerMap)
      const record = toResultRecord(fields, {
        detailUrl: extractDetailUrl($, row, pageUrl),
        sourceUrl: pageUrl,
      })
      if (record) items.push(record)
    })
  }

  return { items, totalPages: extractTotalPages($), totalCount: extractTotalCount($) }
}

/**
 * Parses a result detail page: award header plus the per-lot award breakdown.
 * @returns {{result: object|null, lots: object[]}}
 */
export function parseResultDetail(html, pageUrl, knownReference = null) {
  const $ = loadHtml(html)
  const fields = extractLabelledFields($, $('body'))
  if (!fields.reference && knownReference) fields.reference = knownReference
  if (!fields.reference) fields.reference = extractReference($('h1, h2, .reference').first().text())

  const result = toResultRecord(fields, { detailUrl: pageUrl, sourceUrl: pageUrl })
  const reference = result?.reference ?? normalizeReference(knownReference ?? '')
  const lots = reference ? parseResultLots($, reference) : []
  return { result, lots }
}

/** Extracts the per-lot award rows of a result detail page. */
export function parseResultLots($, reference) {
  const lots = []
  const tables = $('table')

  for (let i = 0; i < tables.length; i += 1) {
    const table = tables.eq(i)
    const headerMap = extractHeaderMap($, table)
    if (!headerMap.some((field) => ['attributaire', 'montantAttribue', 'lotNumber'].includes(field))) continue

    findRows($, table).each((_, element) => {
      const row = $(element)
      const fields = {}
      row.children('td, th').each((index, cell) => {
        const field = headerMap[index]
        if (field) fields[field] = $(cell).text()
      })
      const timestamp = nowIso()
      const lot = {
        consultation_reference: normalizeReference(reference),
        lot_number: cleanOrNull(fields.lotNumber),
        designation: cleanOrNull(fields.designation ?? fields.objet),
        attributaire: cleanOrNull(fields.attributaire),
        attributaire_ice: cleanOrNull(fields.attributaireIce),
        montant_cents: parseAmountToCentimes(fields.montantAttribue),
        lot_status: normalizeResultStatus(fields.resultStatus ?? fields.attributaire),
        nombre_offres: Number.parseInt(clean(fields.nombreOffres), 10) || null,
        raw_json: JSON.stringify(fields),
        created_at: timestamp,
        updated_at: timestamp,
      }
      if (lot.attributaire || lot.montant_cents !== null || lot.lot_number) lots.push(lot)
    })
    if (lots.length > 0) break
  }

  return lots
}

/**
 * Normalises raw scraped fields into a `consultation_results` row.
 *
 * `reference` is deliberately the same normalised value produced by the
 * consultation parser — it is the foreign key the matcher joins on.
 * @returns {object|null} null when no reference can be recovered.
 */
export function toResultRecord(fields, { detailUrl = null, sourceUrl = null } = {}) {
  const referenceRaw = cleanOrNull(fields.reference)
  const reference = referenceRaw ? normalizeReference(referenceRaw) : extractReference(fields.objet ?? '')
  if (!reference) return null

  const timestamp = nowIso()
  const record = {
    reference,
    reference_raw: referenceRaw,
    consultation_id: null,
    objet: cleanOrNull(fields.objet),
    acheteur: cleanOrNull(fields.acheteur),
    categorie: cleanOrNull(fields.categorie),
    nature_prestation: cleanOrNull(fields.naturePrestation),
    lieu_execution: cleanOrNull(fields.lieuExecution),
    procedure_type: cleanOrNull(fields.procedureType),
    date_publication_resultat: parseDate(fields.datePublicationResultat ?? fields.datePublication),
    date_attribution: parseDate(fields.dateAttribution),
    attributaire: cleanOrNull(fields.attributaire),
    attributaire_ice: cleanOrNull(fields.attributaireIce),
    montant_attribue_cents: parseAmountToCentimes(fields.montantAttribue),
    currency: config.invoice.currency,
    nombre_offres: Number.parseInt(clean(fields.nombreOffres), 10) || null,
    result_status: normalizeResultStatus(fields.resultStatus) ?? (fields.attributaire ? 'attribue' : null),
    detail_url: detailUrl,
    source_url: sourceUrl,
    raw_json: JSON.stringify(fields),
    matched_at: null,
    first_seen_at: timestamp,
    last_seen_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
  }

  record.search_text = buildSearchText(record)
  return record
}
