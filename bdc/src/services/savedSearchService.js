import { serializeRow, serializeRows } from './serializers.js'
import { NotFoundError, ValidationError } from '../utils/errors.js'
import { clean } from '../utils/text.js'

const MAX_PER_USER = 25
const MAX_NAME = 80

/**
 * Saved searches: a set of filters a user wants to be told about.
 *
 * The filters stored are the same canonical ones the listings use, so a search
 * saved from a screen reproduces exactly what was on it.
 */
export function createSavedSearchService({ savedSearches, notifications }) {
  const list = async (userId) =>
    (await savedSearches.listForUser(userId)).map((row) => ({
      ...serializeRow(row),
      filters: safeParse(row.filters_json) ?? {},
      notify_new: Boolean(row.notify_new),
      notify_awards: Boolean(row.notify_awards),
      is_active: Boolean(row.is_active),
    }))

  async function create(userId, { name, filters, notifyNew, notifyAwards }) {
    const trimmed = clean(name)
    if (!trimmed) throw new ValidationError('A name is required')
    if (trimmed.length > MAX_NAME) throw new ValidationError(`name must be ${MAX_NAME} characters or fewer`)
    if (!notifyNew && !notifyAwards) {
      throw new ValidationError('Choose at least one thing to be alerted about')
    }
    if ((await savedSearches.countForUser(userId)) >= MAX_PER_USER) {
      throw new ValidationError(`You can keep at most ${MAX_PER_USER} saved searches`)
    }

    return serializeRow(
      await savedSearches.create({ userId, name: trimmed, filters: filters ?? {}, notifyNew, notifyAwards }),
    )
  }

  async function setActive(id, userId, isActive) {
    const search = await savedSearches.findById(id)
    if (!search || search.user_id !== userId) throw new NotFoundError(`Saved search ${id}`)
    return serializeRow(await savedSearches.update(id, { is_active: isActive ? 1 : 0 }))
  }

  async function remove(id, userId) {
    const removed = await savedSearches.remove(id, userId)
    if (removed === 0) throw new NotFoundError(`Saved search ${id}`)
    return { id: Number(id), deleted: true }
  }

  const history = async (userId, limit) => serializeRows(await notifications.listForUser(userId, limit))

  const safeParse = (value) => {
    try {
      return value ? JSON.parse(value) : null
    } catch {
      return null
    }
  }

  return { list, create, setActive, remove, history }
}
