import {
  extractDetailUrl,
  extractLabelledFields,
  extractStatusBadge,
  firstMatch,
  extractTotalCount,
  extractTotalPages,
  findRows,
  loadHtml,
} from './listParser.js'
import { buildSearchText } from './consultationParser.js'
import { clean, cleanOrNull, extractReference, normalizeReference } from '../../utils/text.js'
import { parseDate, nowIso } from '../../utils/dates.js'
import { parseAmountToCentimes } from '../../utils/money.js'
import { config } from '../../config/index.js'
import { RESULT_STATE_SELECTORS } from '../selectors.js'

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
 * Parses a page of the awards listing.
 *
 * Results use the same card as the consultations listing, and unlike the
 * consultations they are complete in the listing itself — winner, amount and
 * the number of quotes received are all on the card, and there is no detail
 * link to follow.
 * @returns {{items: object[], totalPages: number, totalCount: number|null}}
 */
export function parseResultList(html, pageUrl) {
  const $ = loadHtml(html)
  const items = []

  findRows($).each((_, element) => {
    const card = $(element)
    const fields = extractLabelledFields($, card)
    const record = toResultRecord(fields, {
      detailUrl: extractDetailUrl($, card, pageUrl),
      sourceUrl: pageUrl,
      statusLabel: extractStatusBadge($, card) ?? clean(firstMatch($, RESULT_STATE_SELECTORS, card)?.text()),
    })
    if (record) items.push(record)
  })

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
  if (!fields.reference) {
    fields.reference = clean($('h1, h2').first().text()).match(/#\s*([A-Z0-9][A-Z0-9._/-]*)/i)?.[1] ?? null
  }

  const result = toResultRecord(fields, {
    detailUrl: pageUrl,
    sourceUrl: pageUrl,
    statusLabel: extractStatusBadge($, $('body')),
  })
  const reference = result?.reference ?? normalizeReference(knownReference ?? '')
  const lots = reference ? parseResultLots($, reference) : []
  return { result, lots }
}

/** Extracts the per-lot award rows of a result detail page. */
export function parseResultLots($, reference) {
  const lots = []

  $('.accordion-item').each((index, element) => {
    const item = $(element)
    const fields = extractLabelledFields($, item)
    if (!fields.attributaire && !fields.montantAttribue) return

    const timestamp = nowIso()
    lots.push({
      consultation_reference: normalizeReference(reference),
      lot_number: cleanOrNull(fields.lotNumber) ?? String(index + 1),
      designation: cleanOrNull(fields.designation ?? fields.objet),
      attributaire: cleanOrNull(fields.attributaire),
      attributaire_ice: cleanOrNull(fields.attributaireIce),
      montant_cents: parseAmountToCentimes(fields.montantAttribue),
      lot_status: normalizeResultStatus(fields.resultStatus ?? fields.attributaire),
      nombre_offres: Number.parseInt(clean(fields.nombreOffres), 10) || null,
      raw_json: JSON.stringify(fields),
      created_at: timestamp,
      updated_at: timestamp,
    })
  })

  return lots
}

/**
 * Normalises raw scraped fields into a `consultation_results` row.
 *
 * `reference` is deliberately the same normalised value produced by the
 * consultation parser — it is the foreign key the matcher joins on.
 * @returns {object|null} null when no reference can be recovered.
 */
export function toResultRecord(fields, { detailUrl = null, sourceUrl = null, statusLabel = null } = {}) {
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
    result_status:
      normalizeResultStatus(fields.resultStatus ?? statusLabel) ?? (fields.attributaire ? 'attribue' : null),
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
