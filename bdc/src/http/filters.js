import { SEARCH_PARAM_ROOT } from '../scraper/selectors.js'
import { isIsoDate } from '../utils/dates.js'
import { clean, normalize, normalizeReference } from '../utils/text.js'
import { ValidationError } from '../utils/errors.js'

/**
 * Translates incoming query strings into a canonical filter object.
 *
 * Three spellings are accepted for every filter so the front end can forward the
 * portal's own form state untouched:
 *   search_consultation_resultats[reference]=123   (portal form, nested by qs)
 *   reference=123                                   (flat alias)
 *   ref=123                                         (short alias)
 */

const TEXT_FILTERS = Object.freeze({
  reference: ['reference', 'ref'],
  objet: ['objet', 'subject', 'object'],
  categorie: ['categorie', 'category'],
  naturePrestation: ['naturePrestation', 'nature_prestation', 'nature'],
  acheteur: ['acheteur', 'buyer', 'organisme'],
  lieuExecution: ['lieuExecution', 'lieu_execution', 'lieu', 'location'],
  procedureType: ['procedureType', 'procedure'],
  attributaire: ['attributaire', 'winner', 'titulaire'],
})

const DATE_FILTERS = Object.freeze({
  datePublicationStart: ['datePublicationStart', 'date_publication_start', 'publishedFrom'],
  datePublicationEnd: ['datePublicationEnd', 'date_publication_end', 'publishedTo'],
  dateLimiteStart: ['dateLimiteStart', 'date_limite_start', 'closingFrom'],
  dateLimiteEnd: ['dateLimiteEnd', 'date_limite_end', 'closingTo'],
})

const STATUS_VALUES = new Set(['open', 'closed', 'awarded', 'all'])

/** Reads a filter value from the nested portal form, then from its flat aliases. */
function readValue(query, aliases) {
  const nested = query[SEARCH_PARAM_ROOT]
  for (const alias of aliases) {
    if (nested && typeof nested === 'object' && clean(nested[alias])) return clean(nested[alias])
    if (clean(query[alias])) return clean(query[alias])
  }
  return null
}

/**
 * @param {object} query Express `req.query`
 * @returns {object} canonical filters; absent filters are omitted entirely.
 * @throws {ValidationError} when a date range is malformed or inverted.
 */
export function parseFilters(query = {}) {
  const filters = {}
  const problems = []

  for (const [field, aliases] of Object.entries(TEXT_FILTERS)) {
    const value = readValue(query, aliases)
    if (value) filters[field] = value
  }

  for (const [field, aliases] of Object.entries(DATE_FILTERS)) {
    const value = readValue(query, aliases)
    if (!value) continue
    if (!isIsoDate(value)) {
      problems.push(`${field} must be an ISO date (YYYY-MM-DD), received "${value}"`)
      continue
    }
    filters[field] = value
  }

  const freeText = readValue(query, ['q', 'search'])
  if (freeText) filters.q = normalize(freeText)

  const status = readValue(query, ['status', 'etat'])
  if (status) {
    if (!STATUS_VALUES.has(status)) {
      problems.push(`status must be one of ${[...STATUS_VALUES].join(', ')}`)
    } else if (status !== 'all') {
      filters.status = status
    }
  }

  const hasResult = readValue(query, ['hasResult', 'has_result', 'avecResultat'])
  if (hasResult !== null) filters.hasResult = ['1', 'true', 'yes'].includes(hasResult.toLowerCase())

  if (filters.reference) filters.reference = normalizeReference(filters.reference)

  if (filters.datePublicationStart && filters.datePublicationEnd && filters.datePublicationStart > filters.datePublicationEnd) {
    problems.push('datePublicationStart must be before datePublicationEnd')
  }
  if (filters.dateLimiteStart && filters.dateLimiteEnd && filters.dateLimiteStart > filters.dateLimiteEnd) {
    problems.push('dateLimiteStart must be before dateLimiteEnd')
  }

  if (problems.length > 0) throw new ValidationError('Invalid filter parameters', problems)
  return filters
}

/** Sortable columns exposed to API clients, per resource. */
export const SORTABLE = Object.freeze({
  consultations: ['date_publication', 'date_limite', 'acheteur', 'reference', 'estimation_cents', 'updated_at'],
  results: ['date_publication_resultat', 'date_attribution', 'montant_attribue_cents', 'acheteur', 'reference'],
  favorites: ['created_at', 'consultation_reference'],
  invoices: ['issue_date', 'total_cents', 'invoice_number', 'created_at'],
})
