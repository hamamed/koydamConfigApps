import fr from './fr.js'
import en from './en.js'
import ar from './ar.js'

/**
 * UI translation for the admin panel.
 *
 * Only interface text is translated. Scraped content is left exactly as the
 * portal published it — an avis written in French stays in French, because
 * "translating" a legal notice would be inventing text that no one published.
 */
const DICTIONARIES = { fr, en, ar }

export const DEFAULT_LOCALE = 'fr'

/** Right-to-left locales, for the `dir` attribute and the mirrored layout. */
const RTL_LOCALES = new Set(['ar'])

export const LOCALES = Object.freeze([
  { code: 'fr', label: 'Français', dir: 'ltr' },
  { code: 'en', label: 'English', dir: 'ltr' },
  { code: 'ar', label: 'العربية', dir: 'rtl' },
])

export const isSupported = (locale) => Object.hasOwn(DICTIONARIES, locale)

export const directionOf = (locale) => (RTL_LOCALES.has(locale) ? 'rtl' : 'ltr')

/**
 * Builds a `t(key, params)` for one locale.
 *
 * A missing key falls back to the default locale and then to the key itself, so
 * an untranslated string shows up as a visible key rather than as a blank cell.
 * `{name}` placeholders are substituted.
 */
export function translator(locale) {
  const dictionary = DICTIONARIES[locale] ?? DICTIONARIES[DEFAULT_LOCALE]
  const fallback = DICTIONARIES[DEFAULT_LOCALE]

  return function t(key, params = {}) {
    const template = dictionary[key] ?? fallback[key] ?? key
    return template.replace(/\{(\w+)\}/g, (match, name) =>
      Object.hasOwn(params, name) ? String(params[name]) : match,
    )
  }
}

/** The whole dictionary for a locale, for a client that renders its own UI. */
export const dictionaryFor = (locale) => ({ ...DICTIONARIES[DEFAULT_LOCALE], ...(DICTIONARIES[locale] ?? {}) })

/**
 * Picks a locale from, in order: an explicit `?lang=`, the saved cookie, the
 * browser's Accept-Language, the site's configured default, then French.
 */
export function resolveLocale({ query, cookie, acceptLanguage, fallback } = {}) {
  if (isSupported(query)) return query
  if (isSupported(cookie)) return cookie

  for (const part of String(acceptLanguage ?? '').split(',')) {
    const code = part.split(';')[0].trim().slice(0, 2).toLowerCase()
    if (isSupported(code)) return code
  }
  return isSupported(fallback) ? fallback : DEFAULT_LOCALE
}
