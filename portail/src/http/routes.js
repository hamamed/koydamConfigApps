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
 * The origins this portal will return somebody to: itself, and the services it
 * fronts. Built from the same config the chooser links to, so a service added
 * there becomes returnable without a second list to keep in step.
 */
const RETURNABLE = new Set(
  [config.publicUrl, ...config.services.map((service) => service.url)]
    .map((url) => {
      try {
        return new URL(url).origin
      } catch {
        return null
      }
    })
    .filter(Boolean),
)

/**
 * Where to send somebody after signing in.
 *
 * A path here, or an absolute URL at one of the services above. The absolute
 * form is the one that matters: bdc and marches send people here carrying
 * `next=https://bdc.civictrust.ma/panel`, and discarding that meant signing in
 * worked and then dropped you on the chooser to pick the space you had just
 * asked for — which reads as being sent back to the portal for no reason.
 *
 * Anything else is discarded rather than followed, so `?next=` cannot bounce
 * somebody onto another domain wearing the credibility of our sign-in.
 * @returns {string|null}
 */
function safeNext(value) {
  if (typeof value !== 'string' || value === '') return null
  // "//evil.example" is a protocol-relative URL, not a path.
  if (value.startsWith('/')) return value.startsWith('//') ? null : value

  try {
    const target = new URL(value)
    return RETURNABLE.has(target.origin) ? target.href : null
  } catch {
    return null
  }
}

export { servicesOf }
