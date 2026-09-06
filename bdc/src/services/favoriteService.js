import { serializeRow } from './serializers.js'
import { NotFoundError, ValidationError } from '../utils/errors.js'

const MAX_NOTE_LENGTH = 1000

/**
 * Backs the Favorites sub-tab. A favourite stores only the consultation
 * *reference*, never a row id — the same key the matcher uses — so a saved
 * project keeps resolving to its award even if the consultation row is
 * re-created by a later scrape.
 */
export function createFavoriteService({ favorites, consultations }) {
  async function add(userId, consultationId, { note = null, tags = null } = {}) {
    const id = Number(consultationId)
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError('A consultation id is required')
    if (note && note.length > MAX_NOTE_LENGTH) {
      throw new ValidationError(`note must be ${MAX_NOTE_LENGTH} characters or fewer`)
    }

    const consultation = await consultations.findById(id)
    if (!consultation) throw new NotFoundError(`Consultation ${consultationId}`)

    const normalizedTags = Array.isArray(tags) ? tags.join(',') : tags
    return serializeRow(await favorites.add(userId, id, { note, tags: normalizedTags }))
  }

  async function remove(userId, consultationId) {
    const removed = await favorites.remove(userId, Number(consultationId))
    if (removed === 0) throw new NotFoundError(`Favorite ${consultationId}`)
    return { consultationId: Number(consultationId), removed: true }
  }

  /**
   * Favorites tab payload: saved consultations with their award status, so the
   * sub-tab renders from one request.
   */
  async function list(userId, filters, pagination) {
    const { rows, total } = await favorites.listForUser(userId, filters, pagination)

    const data = rows.map((row) => {
      const payload = serializeRow(row)
      payload.favorite = {
        id: row.favorite_id,
        note: row.note,
        tags: row.tags ? row.tags.split(',') : [],
        favorited_at: row.favorited_at,
      }
      payload.result = row.attributaire || row.result_status
        ? {
            attributaire: row.attributaire,
            montant_attribue: payload.montant_attribue ?? null,
            date_attribution: row.date_attribution,
            result_status: row.result_status,
          }
        : null
      payload.isFavorite = true
      delete payload.favorite_id
      return payload
    })

    return { data, total }
  }

  const count = (userId) => favorites.countForUser(userId)

  /** The saved row itself, for showing an existing note on a project page. */
  const find = (userId, consultationId) => favorites.find(userId, Number(consultationId))

  return { add, remove, list, count, find }
}
