import jwt from 'jsonwebtoken'
import { config, serviceByKey } from '../config/index.js'
import { LOCALES, directionOf, resolveLocale, translator } from '../i18n/index.js'

/** Wraps an async handler so a rejected promise reaches the error middleware. */
const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

/**
 * The administration console.
 *
 * It owns no data. Every screen is a view over one of the services' own
 * `/admin/api`, called with the signed-in person's token — so this console
 * cannot see or do anything the person could not already do by signing in to
 * that service directly.
 */
export function registerRoutes(app, { client }) {
  app.get('/health', (_req, res) =>
    res.json({ success: true, data: { status: 'ok', uptime: process.uptime() }, error: null }),
  )

  /** The raw session token, which is also what gets forwarded to a service. */
  const tokenOf = (req) => req.cookies?.[config.auth.cookieName] ?? null

  const userOf = (req) => {
    try {
      const payload = jwt.verify(tokenOf(req), config.auth.jwtSecret)
      return { email: payload.email, role: payload.role, fullName: payload.name ?? null }
    } catch {
      return null
    }
  }

  /**
   * Everything here is administration, so the guard is the whole app rather
   * than a decoration on each route.
   *
   * An ordinary account is turned away here rather than being allowed in to
   * find every panel empty — the services would refuse each call individually
   * and the screens would fill with permission errors instead of an answer.
   */
  /**
   * The reader's language, remembered.
   *
   * Ahead of the admin guard so that the refusal page is in their language
   * too — being turned away in a language you do not read is a worse version
   * of being turned away.
   */
  app.use((req, res, next) => {
    const locale = resolveLocale({ query: req.query.lang, cookie: req.cookies?.lang })
    if (req.query.lang && req.query.lang === locale && req.cookies?.lang !== locale) {
      res.cookie('lang', locale, { httpOnly: false, sameSite: 'lax', maxAge: 365 * 24 * 60 * 60 * 1000, path: '/' })
    }
    req.locale = locale
    res.locals.locale = locale
    res.locals.dir = directionOf(locale)
    res.locals.locales = LOCALES
    res.locals.t = translator(locale)
    // The same URL in another language, for the picker.
    res.locals.langUrl = (code) => {
      const url = new URL(req.originalUrl, config.publicUrl)
      url.searchParams.set('lang', code)
      return `${url.pathname}${url.search}`
    }
    res.setHeader('Content-Language', locale)
    next()
  })

  app.use((req, res, next) => {
    if (req.path === '/health') return next()
    const user = userOf(req)
    if (!user) {
      const back = `${config.publicUrl}${req.originalUrl}`
      return res.redirect(`${config.auth.portalUrl}/login?next=${encodeURIComponent(back)}`)
    }
    if (user.role !== 'admin') {
      return res.status(403).render('denied', { config, user })
    }
    req.user = user
    req.token = tokenOf(req)
    next()
  })

  // ----------------------------------------------------------------- overview
  app.get(
    '/',
    handle(async (req, res) => {
      const [dashboards, systems] = await Promise.all([
        client.fanOut('/dashboard', { token: req.token }),
        client.fanOut('/system', { token: req.token }),
      ])

      const overview = dashboards.map((entry, index) => ({
        service: entry.service,
        error: entry.error ?? systems[index].error,
        dashboard: entry.data,
        system: systems[index].data,
      }))

      res.render('overview', { config, user: req.user, overview })
    }),
  )

  // ------------------------------------------------------------- one service
  // The label is a key; the view resolves it in the reader's language.
  const SCREENS = new Map([
    ['dashboard', { path: '/dashboard', view: 'dashboard', label: 'screen.dashboard' }],
    ['systeme', { path: '/system', view: 'system', label: 'screen.system' }],
    ['parametres', { path: '/settings', view: 'settings', label: 'screen.settings' }],
  ])

  app.get(
    '/s/:service/:screen',
    handle(async (req, res, next) => {
      const service = serviceByKey(req.params.service)
      const screen = SCREENS.get(req.params.screen)
      if (!service || !screen) return next()

      const { data, error } = await client.call(service, screen.path, { token: req.token })
      res.render(`service/${screen.view}`, {
        config,
        user: req.user,
        service,
        screen: req.params.screen,
        screens: [...SCREENS].map(([key, value]) => ({ key, label: value.label })),
        data,
        error,
        notice: req.query.saved ? 'set.saved' : null,
      })
    }),
  )

  /**
   * The accounts, once, for everything.
   *
   * Read from the portal rather than per service: since sign-in moved there,
   * bdc and marches each hold a shadow row created on somebody's first visit,
   * so a per-service list answers "who has been here" when the question is
   * "who has access" — and it answers it twice, differently.
   */
  const accountsScreen = async (req, res, extra = {}) => {
    const { data, error } = await client.accounts('/users', { token: req.token })
    res.render('accounts', { config, user: req.user, accounts: data ?? [], error, created: null, form: {}, ...extra })
  }

  app.get('/comptes', handle((req, res) => accountsScreen(req, res)))

  /**
   * Creating an account.
   *
   * The password comes back once, in the response the portal sends, and is
   * shown once here. It is stored only as a hash, so this screen is the only
   * place it will ever exist in the clear — which is said plainly rather than
   * left for somebody to discover by coming back for it.
   */
  app.post(
    '/comptes',
    handle(async (req, res) => {
      const form = {
        email: String(req.body?.email ?? '').trim(),
        fullName: String(req.body?.fullName ?? '').trim(),
        role: req.body?.role === 'admin' ? 'admin' : 'user',
        services: [req.body?.services ?? []].flat().filter(Boolean),
      }

      const { data, error } = await client.accounts('/users', {
        token: req.token,
        method: 'POST',
        body: { ...form, services: form.services.join(',') },
      })

      // The form comes back filled in on a failure: retyping an address
      // because the role was wrong is a small insult a form can avoid.
      await accountsScreen(req, res, error ? { error, form } : { created: data })
    }),
  )

  /** A settings change, written straight through to the service that owns it. */
  app.post(
    '/s/:service/parametres',
    handle(async (req, res, next) => {
      const service = serviceByKey(req.params.service)
      if (!service) return next()

      // Only what the form actually carried. A blank write-only field means
      // "leave it alone", never "set it to empty" — that is how somebody
      // clears an API key by saving an unrelated setting on the same page.
      const body = { ...(req.body ?? {}) }
      const cleared = [body.clear ?? []].flat().filter(Boolean)
      delete body.clear

      const values = Object.fromEntries(
        Object.entries(body).filter(([, value]) => String(value ?? '').trim() !== ''),
      )
      // Erasing a secret is its own explicit tick, so it can be said and
      // nothing else can say it by accident.
      for (const key of cleared) values[key] = ''

      const { error } = await client.call(service, '/settings', { token: req.token, method: 'PATCH', body: values })
      if (error) {
        const current = await client.call(service, '/settings', { token: req.token })
        return res.status(502).render('service/settings', {
          config,
          user: req.user,
          service,
          screen: 'parametres',
          screens: [...SCREENS].map(([key, value]) => ({ key, label: value.label })),
          data: current.data,
          error,
          notice: null,
        })
      }
      res.redirect(`/s/${service.key}/parametres?saved=1`)
    }),
  )

  /** Starts a crawl on a service, then shows its dashboard again. */
  app.post(
    '/s/:service/crawl',
    handle(async (req, res, next) => {
      const service = serviceByKey(req.params.service)
      if (!service) return next()
      await client.call(service, '/scrape', {
        token: req.token,
        method: 'POST',
        body: { source: req.body.source || 'all' },
      })
      res.redirect(`/s/${service.key}/dashboard`)
    }),
  )

  return app
}
