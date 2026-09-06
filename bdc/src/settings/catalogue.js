import { config } from '../config/index.js'

/**
 * Everything an administrator can change from the Settings screen.
 *
 * A setting lives in the database and falls back to its environment default, so
 * the box keeps working with an empty table and a value can always be reset by
 * clearing the field.
 *
 * One `secret` entry is allowed: the Google Translate key. It is a spending
 * credential — leaking it costs money — which is a different class of thing from
 * JWT_SECRET or DATABASE_URL, where a careless edit locks everyone out or points
 * the app at another database. Those two stay in `.env`.
 *
 * A secret is never read back: `describe()` reports only whether one is set, an
 * empty submission means "leave it alone" rather than "erase it", and clearing
 * one is a separate, explicit action.
 */
export const GROUPS = ['site', 'scraper', 'translation', 'invoice', 'company']

const number = (min, max) => ({ type: 'number', min, max })

export const CATALOGUE = Object.freeze([
  { key: 'site.name', group: 'site', type: 'string', fallback: () => 'Marchés publics' },
  { key: 'site.defaultLocale', group: 'site', type: 'select', options: ['fr', 'en', 'ar'], fallback: () => 'fr' },

  { key: 'scraper.maxPages', group: 'scraper', ...number(1, 2000), fallback: () => config.scraper.maxPages },
  // The portal's own selector offers exactly these; anything else is ignored,
  // so offering a free number would invite a value that silently does nothing.
  {
    key: 'scraper.pageSize',
    group: 'scraper',
    type: 'select',
    options: ['10', '20', '30', '50'],
    fallback: () => String(config.scraper.pageSize),
  },
  // Below about a second the portal starts refusing; this is a public service.
  { key: 'scraper.delayMs', group: 'scraper', ...number(500, 60000), fallback: () => config.scraper.delayMs },
  {
    key: 'scraper.detailConcurrency',
    group: 'scraper',
    ...number(1, 8),
    fallback: () => config.scraper.detailConcurrency,
  },
  { key: 'scraper.fetchDetails', group: 'scraper', type: 'boolean', fallback: () => config.scraper.fetchDetails },
  { key: 'scraper.maxRetries', group: 'scraper', ...number(1, 10), fallback: () => config.scraper.maxRetries },
  { key: 'scraper.timeoutMs', group: 'scraper', ...number(5000, 120000), fallback: () => config.scraper.timeoutMs },
  { key: 'scraper.userAgent', group: 'scraper', type: 'string', fallback: () => config.scraper.userAgent },
  // Display only: what the dashboard says the next run is. The schedule itself
  // lives in bdc-scrape.timer, so this has to be kept in step with it — a value
  // here does not move the timer.
  { key: 'scraper.dailyRunAt', group: 'scraper', type: 'string', fallback: () => '05:30' },
  { key: 'scraper.dailySinceDays', group: 'scraper', ...number(1, 60), fallback: () => 7 },

  {
    key: 'translation.googleApiKey',
    group: 'translation',
    type: 'secret',
    // Falls back to the environment, so a key already in .env keeps working and
    // the panel can take over from it later.
    fallback: () => config.translation.apiKey,
  },

  { key: 'invoice.currency', group: 'invoice', type: 'string', fallback: () => config.invoice.currency },
  { key: 'invoice.taxRate', group: 'invoice', ...number(0, 100), fallback: () => config.invoice.taxRate },
  { key: 'invoice.numberPrefix', group: 'invoice', type: 'string', fallback: () => config.invoice.numberPrefix },

  { key: 'company.name', group: 'company', type: 'string', fallback: () => config.company.name },
  { key: 'company.ice', group: 'company', type: 'string', fallback: () => config.company.ice },
  { key: 'company.address', group: 'company', type: 'string', fallback: () => config.company.address },
  { key: 'company.email', group: 'company', type: 'string', fallback: () => config.company.email },
  { key: 'company.phone', group: 'company', type: 'string', fallback: () => config.company.phone },
])

export const BY_KEY = new Map(CATALOGUE.map((entry) => [entry.key, entry]))

/** Parses and range-checks a submitted value against its definition. */
export function coerce(definition, raw) {
  if (raw === null || raw === undefined || raw === '') return null // reset to the fallback

  switch (definition.type) {
    case 'number': {
      const value = Number(raw)
      if (!Number.isFinite(value)) throw new Error(`${definition.key} must be a number`)
      if (definition.min !== undefined && value < definition.min) {
        throw new Error(`${definition.key} must be at least ${definition.min}`)
      }
      if (definition.max !== undefined && value > definition.max) {
        throw new Error(`${definition.key} must be at most ${definition.max}`)
      }
      return value
    }
    case 'boolean':
      return ['1', 'true', 'yes', 'on', true].includes(typeof raw === 'string' ? raw.toLowerCase() : raw)
    case 'select':
      if (!definition.options.includes(String(raw))) {
        throw new Error(`${definition.key} must be one of ${definition.options.join(', ')}`)
      }
      return String(raw)
    case 'secret':
      // Not trimmed the way a plain string is — a key is used verbatim, and
      // silently altering one produces an authentication error nobody can
      // explain. Surrounding whitespace from a paste is the one exception.
      return String(raw).trim()
    default:
      return String(raw).trim()
  }
}
