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

  /** The Settings screen: every definition with its current and default value. */
  async function describe() {
    const values = await load()
    const stored = new Map((await settings.all()).map((row) => [row.key, row]))

    return GROUPS.map((group) => ({
      group,
      entries: CATALOGUE.filter((definition) => definition.group === group).map((definition) => ({
        key: definition.key,
        type: definition.type,
        options: definition.options ?? null,
        min: definition.min ?? null,
        max: definition.max ?? null,
        value: values[definition.key],
        fallback: definition.fallback(),
        isOverridden: stored.has(definition.key),
        updatedAt: stored.get(definition.key)?.updated_at ?? null,
      })),
    }))
  }

  /**
   * Applies a form submission. Unknown keys are ignored rather than rejected, so
   * a stale browser tab cannot fail the whole save; an out-of-range value is
   * refused with the key named.
   */
  async function update(patch, userId = null) {
    const problems = []
    const applied = []

    for (const [key, raw] of Object.entries(patch ?? {})) {
      const definition = BY_KEY.get(key)
      if (!definition) continue
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
    log.info('settings updated', { keys: applied.length, by: userId })
    return { updated: applied.length }
  }

  /** Test and admin seam: forces the next read to hit the database. */
  const invalidate = () => {
    cache = null
  }

  return { get, section, describe, update, invalidate }
}
