import { resolveLocale, translator, directionOf, LOCALES, DEFAULT_LOCALE } from '../../i18n/index.js'

const COOKIE_NAME = 'lang'
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000

/**
 * Resolves the request's locale and exposes it to routes and views.
 *
 * An explicit `?lang=` is remembered in a cookie, so switching language once
 * survives the redirect that follows and every later page.
 */
export function localeMiddleware(settings = null) {
  return async (req, res, next) => {
    // The site's configured default is the last word before French, so an
    // Arabic-first deployment does not depend on every visitor's browser.
    const fallback = settings ? await settings.get('site.defaultLocale') : undefined
    const locale = resolveLocale({
      query: req.query?.lang,
      cookie: req.cookies?.[COOKIE_NAME],
      acceptLanguage: req.headers['accept-language'],
      fallback,
    })

    if (req.query?.lang && req.query.lang === locale && req.cookies?.[COOKIE_NAME] !== locale) {
      res.cookie(COOKIE_NAME, locale, { httpOnly: false, sameSite: 'lax', maxAge: COOKIE_MAX_AGE_MS, path: '/' })
    }

    req.locale = locale
    res.locals.locale = locale
    res.locals.dir = directionOf(locale)
    res.locals.locales = LOCALES
    res.locals.defaultLocale = DEFAULT_LOCALE
    res.locals.t = translator(locale)
    // Keeps the current query string when switching language.
    res.locals.langUrl = (code) => {
      const params = new URLSearchParams(req.query ?? {})
      params.set('lang', code)
      return `${req.path}?${params.toString()}`
    }
    res.setHeader('Content-Language', locale)
    next()
  }
}
