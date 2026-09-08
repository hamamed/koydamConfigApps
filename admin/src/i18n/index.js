import fr from './fr.js'
import en from './en.js'
import ar from './ar.js'
import settingLabels from '../labels.js'

/**
 * Interface text for the console, in the three languages the services already
 * speak.
 *
 * The settings labels are merged underneath: they are lifted from the services'
 * own dictionaries and exist in French only, so an English or Arabic reader
 * sees a French field name rather than a raw key. Naming a setting wrongly in
 * a language would be worse than naming it in the wrong language.
 */
const DICTIONARIES = { fr, en, ar }

export const DEFAULT_LOCALE = 'fr'
const RTL_LOCALES = new Set(['ar'])

export const LOCALES = Object.freeze([
  { code: 'fr', label: 'Français' },
  { code: 'en', label: 'English' },
  { code: 'ar', label: 'العربية' },
])

export const isSupported = (locale) => Object.hasOwn(DICTIONARIES, locale)
export const directionOf = (locale) => (RTL_LOCALES.has(locale) ? 'rtl' : 'ltr')

/**
 * Builds a `t(key, params)`.
 *
 * A missing key falls back to the default locale, then to the settings labels,
 * then to the key itself — visible as a key rather than as a blank cell, so an
 * untranslated string is obvious instead of silently missing.
 */
export function translator(locale) {
  const dictionary = DICTIONARIES[locale] ?? DICTIONARIES[DEFAULT_LOCALE]
  const fallback = DICTIONARIES[DEFAULT_LOCALE]

  return function t(key, params = {}) {
    const template = dictionary[key] ?? fallback[key] ?? settingLabels[key] ?? key
    return String(template).replace(/\{(\w+)\}/g, (match, name) =>
      Object.hasOwn(params, name) ? String(params[name]) : match,
    )
  }
}

/** Query string, then the remembered cookie, then French. */
export function resolveLocale({ query, cookie } = {}) {
  if (isSupported(query)) return query
  if (isSupported(cookie)) return cookie
  return DEFAULT_LOCALE
}
