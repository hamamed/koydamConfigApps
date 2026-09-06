import { serializeConsultation, serializeRow, serializeRows } from './serializers.js'
import { NotFoundError } from '../utils/errors.js'
import { normalizeReference } from '../utils/text.js'

/**
 * Read model for the public listing screens. Every consultation is returned
 * already joined to its award (when one has been published), which is the whole
 * point of the reference-based matching.
 */
export function createConsultationService({ consultations, articles, results, favorites, matcher }) {
  /**
   * @param {object} filters canonical filters from http/filters.js
   * @param {{limit:number, offset:number, sort?:string}} pagination
   * @param {number|null} userId when set, each row is decorated with `isFavorite`
   */
  async function search(filters, pagination, userId = null) {
    const { rows, total } = await consultations.search(filters, pagination)
    const favoriteRefs = userId ? await favorites.referencesForUser(userId) : null

    const data = rows.map((row) => {
      const payload = serializeRow(row)
      payload.result = row.attributaire || row.result_status
        ? {
            attributaire: row.attributaire,
            montant_attribue: payload.montant_attribue ?? null,
            date_attribution: row.date_attribution,
            result_status: row.result_status,
          }
        : null
      if (favoriteRefs) payload.isFavorite = favoriteRefs.has(row.reference)
      return payload
    })

    return { data, total }
  }

  /** Full detail: header, article/lot breakdown and matched award. */
  async function getByReference(rawReference, userId = null) {
    const reference = normalizeReference(rawReference)
    const consultation = await consultations.findByReference(reference)
    if (!consultation) throw new NotFoundError(`Consultation ${rawReference}`)

    const [rows, result, favorite] = await Promise.all([
      articles.findByConsultationId(consultation.id),
      matcher.findResultFor(reference),
      userId ? favorites.find(userId, reference) : Promise.resolve(null),
    ])

    return serializeConsultation(consultation, {
      articles: rows,
      result,
      ...(userId ? { isFavorite: Boolean(favorite) } : {}),
    })
  }

  /** Article/lot rows of a consultation — the input to the invoice generator. */
  async function listArticles(rawReference) {
    const reference = normalizeReference(rawReference)
    const consultation = await consultations.findByReference(reference)
    if (!consultation) throw new NotFoundError(`Consultation ${rawReference}`)
    return serializeRows(await articles.findByConsultationId(consultation.id))
  }

  async function searchResults(filters, pagination) {
    const { rows, total } = await results.search(filters, pagination)
    return { data: serializeRows(rows), total }
  }

  async function getResultByReference(rawReference) {
    const reference = normalizeReference(rawReference)
    const result = await matcher.findResultFor(reference)
    if (!result) throw new NotFoundError(`Result for ${rawReference}`)
    return { ...serializeRow(result), lots: serializeRows(result.lots) }
  }

  return { search, getByReference, listArticles, searchResults, getResultByReference }
}
