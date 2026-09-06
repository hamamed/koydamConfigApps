import ar from './ar.js'
import en from './en.js'
import fr from './fr.js'

/**
 * The public pages' prose, by locale.
 *
 * French is the fallback rather than English: the portal publishes in French,
 * every avis in the database is in French, and a Moroccan reader who lands on a
 * locale we do not have is better served by it than by English.
 */
const CONTENT = Object.freeze({ fr, en, ar })

export const CONTENT_LOCALES = Object.keys(CONTENT)

export function contentFor(locale) {
  return CONTENT[locale] ?? CONTENT.fr
}

export { CONTENT }
