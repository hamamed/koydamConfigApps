import jwt from 'jsonwebtoken'
import { config, serviceByKey } from '../config/index.js'

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
  const SCREENS = new Map([
    ['dashboard', { path: '/dashboard', view: 'dashboard', label: 'Tableau de bord' }],
    ['systeme', { path: '/system', view: 'system', label: 'Système' }],
    ['parametres', { path: '/settings', view: 'settings', label: 'Paramètres' }],
    ['comptes', { path: '/users', view: 'users', label: 'Comptes' }],
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
        notice: req.query.saved ? 'Enregistré.' : null,
      })
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
      const values = Object.fromEntries(
        Object.entries(req.body ?? {}).filter(([, value]) => String(value ?? '').trim() !== ''),
      )

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
