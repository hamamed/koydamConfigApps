import { CATALOGUE, BY_KEY, GROUPS, coerce } from './catalogue.js'
import { ValidationError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

const log = logger.child('[settings]')

/**
 * Runtime configuration, stored in the database and falling back to `.env`.
 *
 * Values are cached because the scraper reads them on every request; the cache
 * is dropped on any write, so a change takes effect on the next crawl without a
 * restart. Nothing here is a secret — see catalogue.js.
 */
export function createSettingsService({ settings }) {
  let cache = null

  async function load() {
    if (cache) return cache
    const stored = new Map()
    for (const row of await settings.all()) {
      try {
        stored.set(row.key, JSON.parse(row.value))
      } catch {
        log.warn('unreadable setting, using the fallback', { key: row.key })
      }
    }

    cache = {}
    for (const definition of CATALOGUE) {
      cache[definition.key] = stored.has(definition.key) ? stored.get(definition.key) : definition.fallback()
    }
    return cache
  }

  const get = async (key) => (await load())[key]

  /** Values grouped by prefix: `scraper.maxPages` becomes `scraper.maxPages`. */
  async function section(prefix) {
    const values = await load()
    return Object.fromEntries(
      Object.entries(values)
        .filter(([key]) => key.startsWith(`${prefix}.`))
        .map(([key, value]) => [key.slice(prefix.length + 1), value]),
    )
  }

  /**
   * The Settings screen: every definition with its current and default value.
   *
   * A secret's value never leaves this function — not to the page, not to the
   * JSON API, not into a log. The screen gets `isSet` and nothing else, because
   * a field that renders the key back is a field that leaks it to anyone who
   * views source, and to every future error report that includes the response.
   */
  async function describe() {
    const values = await load()
    const stored = new Map((await settings.all()).map((row) => [row.key, row]))

    return GROUPS.map((group) => ({
      group,
      entries: CATALOGUE.filter((definition) => definition.group === group).map((definition) => {
        const isSecret = definition.type === 'secret'
        const value = values[definition.key]
        return {
          key: definition.key,
          type: definition.type,
          options: definition.options ?? null,
          min: definition.min ?? null,
          max: definition.max ?? null,
          value: isSecret ? null : value,
          fallback: isSecret ? null : definition.fallback(),
          isSet: isSecret ? Boolean(value) : undefined,
          // Whether the value came from the panel or from .env — worth showing,
          // because "it is set but not by you" explains a lot.
          fromEnvironment: isSecret ? Boolean(value) && !stored.has(definition.key) : undefined,
          isOverridden: stored.has(definition.key),
          updatedAt: stored.get(definition.key)?.updated_at ?? null,
        }
      }),
    }))
  }

  /**
   * Applies a form submission. Unknown keys are ignored rather than rejected, so
   * a stale browser tab cannot fail the whole save; an out-of-range value is
   * refused with the key named.
   *
   * @param {object} patch key -> submitted value.
   * @param {number|null} userId who is saving.
   * @param {{clear?: string[]}} [options] keys to reset to their fallback.
   *   Clearing a secret has to be deliberate: the field renders empty every
   *   time, so treating "empty" as "erase" would wipe the key on any save that
   *   did not retype it.
   */
  async function update(patch, userId = null, { clear = [] } = {}) {
    const problems = []
    const applied = []

    for (const key of clear) {
      if (!BY_KEY.has(key)) continue
      await settings.set(key, null, userId)
      applied.push(key)
    }

    for (const [key, raw] of Object.entries(patch ?? {})) {
      const definition = BY_KEY.get(key)
      if (!definition) continue
      if (clear.includes(key)) continue
      // An untouched secret field submits empty. That means "no change", not
      // "reset" — see the note above.
      if (definition.type === 'secret' && String(raw ?? '').trim() === '') continue
      try {
        const value = coerce(definition, raw)
        await settings.set(key, value, userId)
        applied.push(key)
      } catch (error) {
        problems.push(error.message)
      }
    }

    cache = null
    if (problems.length > 0) throw new ValidationError('Invalid settings', problems)
    // Keys only. A value here would put a secret in the log.
    log.info('settings updated', { keys: applied, by: userId })
    return { updated: applied.length }
  }

  /** Test and admin seam: forces the next read to hit the database. */
  const invalidate = () => {
    cache = null
  }

  return { get, section, describe, update, invalidate }
}
