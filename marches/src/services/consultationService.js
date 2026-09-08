import { serializeConsultation, serializeRow, serializeRows } from './serializers.js'
import { NotFoundError } from '../utils/errors.js'

/**
 * Read model for the public listing screens. Every consultation is returned
 * already joined to its award (when one has been published), which is the whole
 * point of the reference-based matching.
 */
export function createConsultationService({ consultations, documents, favorites }) {
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
   * Full detail: the header and the published attachments.
   *
   * No article breakdown and no award. The appel d'offres portal publishes
   * neither on a consultation page: the lots live inside the downloadable
   * dossier, and an award appears later as a separate "résultat définitif"
   * notice this service does not crawl. Loading them meant two queries per
   * page that could only ever return nothing.
   */
  async function getById(id, userId = null) {
    const consultation = await consultations.findById(id)
    if (!consultation) throw new NotFoundError(`Consultation ${id}`)

    const [files, favorite] = await Promise.all([
      documents.findByConsultationId(consultation.id),
      userId ? favorites.find(userId, consultation.id) : Promise.resolve(null),
    ])

    return serializeConsultation(consultation, {
      documents: files,
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

  return { search, getById, findByReference }
}
