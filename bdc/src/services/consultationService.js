import { serializeConsultation, serializeRow, serializeRows } from './serializers.js'
import { NotFoundError } from '../utils/errors.js'

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
    const favoriteIds = userId ? await favorites.idsForUser(userId) : null

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
      if (favoriteIds) payload.isFavorite = favoriteIds.has(row.id)
      return payload
    })

    return { data, total }
  }

  /**
   * Full detail: header, article breakdown and the matched award.
   * Addressed by id — a reference is not unique across buyers.
   */
  async function getById(id, userId = null) {
    const consultation = await consultations.findById(id)
    if (!consultation) throw new NotFoundError(`Consultation ${id}`)

    const [rows, result, favorite] = await Promise.all([
      articles.findByConsultationId(consultation.id),
      matcher.findResultFor(consultation.id),
      userId ? favorites.find(userId, consultation.id) : Promise.resolve(null),
    ])

    return serializeConsultation(consultation, {
      articles: rows,
      result,
      ...(userId ? { isFavorite: Boolean(favorite) } : {}),
    })
  }

  /**
   * Every consultation published under a reference. References repeat across
   * buyers, so this is a search, not a lookup.
   */
  async function findByReference(reference) {
    return serializeRows(await consultations.findByReference(reference))
  }

  /** Article rows of a consultation — the input to the invoice generator. */
  async function listArticles(id) {
    const consultation = await consultations.findById(id)
    if (!consultation) throw new NotFoundError(`Consultation ${id}`)
    return serializeRows(await articles.findByConsultationId(consultation.id))
  }

  async function searchResults(filters, pagination) {
    const { rows, total } = await results.search(filters, pagination)
    return { data: serializeRows(rows), total }
  }

  async function getResultForConsultation(consultationId) {
    const result = await matcher.findResultFor(consultationId)
    if (!result) throw new NotFoundError(`Result for consultation ${consultationId}`)
    return { ...serializeRow(result), lots: serializeRows(result.lots) }
  }

  async function getResultById(id) {
    const result = await results.findById(id)
    if (!result) throw new NotFoundError(`Result ${id}`)
    return { ...serializeRow(result), lots: serializeRows(await results.findLots(id)) }
  }

  return {
    search,
    getById,
    findByReference,
    listArticles,
    searchResults,
    getResultForConsultation,
    getResultById,
  }
}
