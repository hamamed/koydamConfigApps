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
import { DOCUMENT_LINK_SELECTORS } from '../selectors.js'
import { clean, cleanOrNull, matchKey, normalize, normalizeReference } from '../../utils/text.js'
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
 * Attachments published with an avis, and with its cancellation notice.
 *
 * The links are relative, so they are resolved against the page they came from;
 * the files stay on the portal and are linked, not copied.
 * @returns {object[]} rows for `consultation_documents`.
 */
export function parseDocuments($, pageUrl) {
  const timestamp = nowIso()
  const seen = new Set()
  const documents = []

  for (const selector of DOCUMENT_LINK_SELECTORS) {
    $(selector).each((_, node) => {
      const link = $(node)
      const href = link.attr('href')
      if (!href) return

      let url
      try {
        url = new URL(href, pageUrl).toString()
      } catch {
        return
      }
      if (seen.has(url)) return
      seen.add(url)

      const isCancellation = /\/download\/annulation\//.test(url)
      const label = clean(link.text())
      documents.push({
        kind: isCancellation ? 'annulation' : 'avis',
        // The cancellation link is only ever labelled "Télécharger", which is
        // not a name; the file id at least distinguishes one from another.
        file_name: label && !/^t[ée]l[ée]charger$/i.test(label) ? label : null,
        url,
        source_file_id: url.match(/\/(\d+)$/)?.[1] ?? null,
        created_at: timestamp,
        updated_at: timestamp,
      })
    })
  }

  return documents
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
  const articles = parseArticles($)
  const documents = parseDocuments($, pageUrl)

  if (consultation && articles.length > 0 && !consultation.lots_count) {
    consultation.lots_count = articles.length
  }

  return { consultation, articles, documents }
}

/**
 * Normalises raw scraped fields into a `consultations` row.
 * @returns {object|null} null when the row carries no usable reference.
 */
export function toConsultationRecord(fields, { detailUrl = null, sourceUrl = null, statusLabel = null, sourceId = null } = {}) {
  const referenceRaw = cleanOrNull(fields.reference)
  const reference = referenceRaw ? normalizeReference(referenceRaw) : null
  // The portal's own id is the identity. A card without one cannot be told
  // apart from another buyer's avis carrying the same reference, so it is
  // dropped rather than merged into an unrelated row.
  const identity = sourceId ?? extractSourceId(detailUrl)
  if (!reference || !identity) return null

  const timestamp = nowIso()
  const record = {
    source_id: identity,
    reference,
    reference_raw: referenceRaw,
    match_key: matchKey(reference, fields.acheteur),
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
    // The scraper reports only what the portal says — whether the avis was
    // withdrawn. The lifecycle `status` column is derived by the matcher, which
    // also knows about awards and expired deadlines; letting a listing pass
    // write it would reset "awarded" on every crawl.
    is_cancelled: /annul/i.test(statusLabel ?? '') || fields.dateAnnulation ? 1 : 0,
    detail_url: detailUrl,
    source_url: sourceUrl,
    raw_json: JSON.stringify(fields),
    first_seen_at: timestamp,
    last_seen_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
  }

  record.search_text = buildSearchText(record)
  return record
}

/** The numeric id the portal puts in a consultation's detail URL. */
export function extractSourceId(url) {
  return clean(url).match(/\/show\/(\d+)/)?.[1] ?? null
}

/** Accent-free haystack backing the free-text `q` filter. */
export function buildSearchText(record) {
  return normalize(
    [record.reference, record.objet, record.acheteur, record.categorie, record.nature_prestation, record.lieu_execution]
      .filter(Boolean)
      .join(' '),
  )
}
