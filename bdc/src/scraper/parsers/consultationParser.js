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
import { parseArticles } from './articleParser.js'
import { clean, cleanOrNull, extractReference, normalize, normalizeReference } from '../../utils/text.js'
import { parseDate, parseTime, nowIso } from '../../utils/dates.js'
import { parseAmountToCentimes } from '../../utils/money.js'

/**
 * Parses a page of the open-consultations listing.
 * @returns {{items: object[], totalPages: number, totalCount: number|null}}
 */
export function parseConsultationList(html, pageUrl) {
  const $ = loadHtml(html)
  const table = findListTable($)
  const items = []

  if (table) {
    const headerMap = extractHeaderMap($, table)
    findRows($, table).each((_, element) => {
      const row = $(element)
      const fields = extractRowFields($, row, headerMap)
      const record = toConsultationRecord(fields, {
        detailUrl: extractDetailUrl($, row, pageUrl),
        sourceUrl: pageUrl,
      })
      if (record) items.push(record)
    })
  }

  return {
    items,
    totalPages: extractTotalPages($),
    totalCount: extractTotalCount($),
  }
}

/**
 * Parses a consultation detail page: the header fields plus the full article /
 * lot breakdown.
 * @returns {{consultation: object|null, articles: object[]}}
 */
export function parseConsultationDetail(html, pageUrl, knownReference = null) {
  const $ = loadHtml(html)
  const fields = extractLabelledFields($, $('body'))

  if (!fields.reference && knownReference) fields.reference = knownReference
  if (!fields.reference) fields.reference = extractReference($('h1, h2, .reference').first().text())
  if (!fields.objet) fields.objet = clean($('h1, h2').first().text()) || null

  const consultation = toConsultationRecord(fields, { detailUrl: pageUrl, sourceUrl: pageUrl })
  const reference = consultation?.reference ?? normalizeReference(knownReference ?? '')
  const articles = reference ? parseArticles($, reference) : []

  if (consultation && articles.length > 0 && !consultation.lots_count) {
    consultation.lots_count = articles.length
  }

  return { consultation, articles }
}

/**
 * Normalises raw scraped fields into a `consultations` row.
 * @returns {object|null} null when the row carries no usable reference.
 */
export function toConsultationRecord(fields, { detailUrl = null, sourceUrl = null } = {}) {
  const referenceRaw = cleanOrNull(fields.reference)
  const reference = referenceRaw ? normalizeReference(referenceRaw) : extractReference(fields.objet ?? '')
  if (!reference) return null

  const timestamp = nowIso()
  const record = {
    reference,
    reference_raw: referenceRaw,
    objet: cleanOrNull(fields.objet),
    acheteur: cleanOrNull(fields.acheteur),
    acheteur_service: cleanOrNull(fields.acheteurService),
    categorie: cleanOrNull(fields.categorie),
    nature_prestation: cleanOrNull(fields.naturePrestation),
    lieu_execution: cleanOrNull(fields.lieuExecution),
    procedure_type: cleanOrNull(fields.procedureType),
    mode_passation: cleanOrNull(fields.modePassation),
    date_publication: parseDate(fields.datePublication),
    date_limite: parseDate(fields.dateLimite),
    heure_limite: parseTime(fields.dateLimite),
    date_ouverture_plis: parseDate(fields.dateOuverturePlis),
    estimation_cents: parseAmountToCentimes(fields.estimation),
    caution_provisoire_cents: parseAmountToCentimes(fields.cautionProvisoire),
    qualification: cleanOrNull(fields.qualification),
    agrement: cleanOrNull(fields.agrement),
    lots_count: Number.parseInt(clean(fields.lotsCount), 10) || 0,
    detail_url: detailUrl,
    source_url: sourceUrl,
    source_id: detailUrl ? (detailUrl.match(/(\d{4,})/)?.[1] ?? null) : null,
    raw_json: JSON.stringify(fields),
    first_seen_at: timestamp,
    last_seen_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
  }

  record.search_text = buildSearchText(record)
  return record
}

/** Accent-free haystack backing the free-text `q` filter. */
export function buildSearchText(record) {
  return normalize(
    [record.reference, record.objet, record.acheteur, record.categorie, record.nature_prestation, record.lieu_execution]
      .filter(Boolean)
      .join(' '),
  )
}
