import {
  extractDetailUrl,
  extractLabelledFields,
  extractStatusBadge,
  extractTotalCount,
  extractTotalPages,
  findRows,
  loadHtml,
} from './listParser.js'
import { parseArticles } from './articleParser.js'
import { clean, cleanOrNull, extractReference, normalize, normalizeReference } from '../../utils/text.js'
import { parseDate, parseTime, nowIso } from '../../utils/dates.js'
import { parseAmountToCentimes } from '../../utils/money.js'

/**
 * Parses a page of the open-consultations listing.
 *
 * Rows are Bootstrap cards (`.entreprise__card`), ten to a page. The card
 * carries reference, objet, acheteur, the deadline and the execution location;
 * category, nature and publication date only exist on the detail page.
 * @returns {{items: object[], totalPages: number, totalCount: number|null}}
 */
export function parseConsultationList(html, pageUrl) {
  const $ = loadHtml(html)
  const items = []

  findRows($).each((_, element) => {
    const card = $(element)
    const fields = extractLabelledFields($, card)
    const record = toConsultationRecord(fields, {
      detailUrl: extractDetailUrl($, card, pageUrl),
      sourceUrl: pageUrl,
      statusLabel: extractStatusBadge($, card),
    })
    if (record) items.push(record)
  })

  return { items, totalPages: extractTotalPages($), totalCount: extractTotalCount($) }
}

/**
 * Parses a consultation detail page: the header fields plus the full article /
 * lot breakdown.
 * @returns {{consultation: object|null, articles: object[]}}
 */
export function parseConsultationDetail(html, pageUrl, knownReference = null) {
  const $ = loadHtml(html)
  const fields = extractLabelledFields($, $('body'))

  // The reference is not a labelled field on the detail page; the only reliable
  // carrier is the document title, "Détails de l'avis d'achat #53/2026".
  // Scanning headings instead picks up the article accordion, whose entries all
  // start with "#01".
  if (!fields.reference) {
    const title = clean($('title').text())
    fields.reference = title.match(/#\s*([A-Z0-9][A-Z0-9._/-]*)/i)?.[1] ?? knownReference
  }
  if (!fields.objet) fields.objet = clean($('h1, h2').first().text()) || null

  const consultation = toConsultationRecord(fields, {
    detailUrl: pageUrl,
    sourceUrl: pageUrl,
    statusLabel: extractStatusBadge($, $('body')),
  })
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
export function toConsultationRecord(fields, { detailUrl = null, sourceUrl = null, statusLabel = null } = {}) {
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
    lots_count: 0,
    date_annulation: parseDate(fields.dateAnnulation),
    motif_annulation: cleanOrNull(fields.motifAnnulation),
    status: /annul/i.test(statusLabel ?? '') || fields.dateAnnulation ? 'annule' : 'open',
    detail_url: detailUrl,
    source_url: sourceUrl,
    source_id: detailUrl ? (detailUrl.match(/\/show\/(\d+)/)?.[1] ?? detailUrl.match(/(\d{4,})/)?.[1] ?? null) : null,
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
