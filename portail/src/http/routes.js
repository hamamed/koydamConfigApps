import { config } from '../config/index.js'
import { cookieOptions, clearCookieOptions } from './cookies.js'
import { createLoginLimiter } from './rateLimit.js'
import { UnauthorizedError } from '../utils/errors.js'
import { servicesOf } from '../services/authService.js'

/** Wraps an async handler so a rejected promise reaches the error middleware. */
const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

/**
 * The front door.
 *
 * Three screens and nothing else: a landing page describing what is here, one
 * sign-in form, and the chooser that follows it. Everything a person actually
 * does happens in bdc or marches — this only decides who they are and hands the
 * session to whichever one they pick.
 */
export function registerRoutes(app, { services }) {
  const loginLimiter = createLoginLimiter()

  app.get('/health', (_req, res) => res.json({ success: true, data: { status: 'ok', uptime: process.uptime() }, error: null }))

  /** Reads the shared session without demanding one. */
  const currentUser = (req) => {
    try {
      return services.auth.verifyToken(req.cookies?.[config.auth.cookieName])
    } catch {
      return null
    }
  }

  /** The services this session may open, in the order the config declares them. */
  const availableTo = (user) =>
    config.services.filter(
      (service) => config.enabledServices.includes(service.key) && user.services.includes(service.key),
    )

  // ------------------------------------------------------------------ landing
  app.get('/', (req, res) => {
    const user = currentUser(req)
    // Somebody already signed in does not want to read the pitch again.
    if (user) return res.redirect('/choisir')
    res.render('landing', { config, services: config.services.filter((s) => config.enabledServices.includes(s.key)) })
  })

  // ------------------------------------------------------------------- sign in
  app.get('/login', (req, res) => {
    if (currentUser(req)) return res.redirect(safeNext(req.query.next) ?? '/choisir')
    res.render('login', { config, error: null, email: '', next: safeNext(req.query.next) ?? '' })
  })

  app.post(
    '/login',
    loginLimiter,
    handle(async (req, res) => {
      const next = safeNext(req.body.next) ?? '/choisir'
      try {
        const { token } = await services.auth.login(req.body.email, req.body.password, {
          ip: req.ip,
          userAgent: req.get('user-agent'),
        })
        res.cookie(config.auth.cookieName, token, cookieOptions())
        res.redirect(next)
      } catch (error) {
        if (!(error instanceof UnauthorizedError)) throw error
        res.status(401).render('login', {
          config,
          error: 'Adresse e-mail ou mot de passe incorrect.',
          email: req.body.email ?? '',
          next: next === '/choisir' ? '' : next,
        })
      }
    }),
  )

  app.post('/logout', (req, res) => {
    // Cleared with the same domain and path it was set with — a mismatch leaves
    // the cookie in place and "signed out" would last until the tab closed.
    res.clearCookie(config.auth.cookieName, clearCookieOptions())
    res.redirect('/')
  })

  // ------------------------------------------------------------------ chooser
  app.get('/choisir', (req, res) => {
    const user = currentUser(req)
    if (!user) return res.redirect(`/login?next=${encodeURIComponent('/choisir')}`)
    res.render('choose', { config, user, available: availableTo(user) })
  })

  /**
   * Hands the session to a service.
   *
   * The redirect goes through here rather than straight from the chooser so
   * that the jump is recorded and an account without access to a service is
   * turned away by this server rather than by the other one's login page.
   */
  app.get(
    '/aller/:service',
    handle(async (req, res) => {
      const user = currentUser(req)
      if (!user) return res.redirect(`/login?next=${encodeURIComponent(`/aller/${req.params.service}`)}`)

      const target = availableTo(user).find((service) => service.key === req.params.service)
      if (!target) return res.status(403).render('error', { status: 403, message: "Cet espace ne vous est pas ouvert.", config })

      await services.signIns
        ?.add({ userId: user.id, email: user.email, outcome: 'opened', service: target.key, ip: req.ip, userAgent: req.get('user-agent') })
        .catch(() => {})
      res.redirect(target.url)
    }),
  )

  return app
}

/**
 * Only same-site paths, so `?next=` cannot be used to bounce somebody to
 * another domain carrying the appearance of our sign-in.
 * @returns {string|null}
 */
function safeNext(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null
  return value
}

export { servicesOf }
