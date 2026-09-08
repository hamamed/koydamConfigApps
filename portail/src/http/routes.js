import { webcrypto } from 'node:crypto'
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
  /**
   * The session token: the cookie a browser sends, or a bearer credential.
   *
   * The bearer form is not decoration. The administration console reads the
   * accounts from here on an administrator's behalf, server to server, where
   * there is no cookie jar — it forwards the person's own token as a header,
   * exactly as it does to bdc and marches. Reading only the cookie made that
   * call arrive as an anonymous one and the accounts screen render empty with
   * "Not signed in" above it.
   */
  const tokenOf = (req) => {
    const header = req.headers.authorization ?? ''
    if (header.startsWith('Bearer ')) return header.slice('Bearer '.length).trim()
    return req.cookies?.[config.auth.cookieName] ?? null
  }

  const currentUser = (req) => {
    try {
      return services.auth.verifyToken(tokenOf(req))
    } catch {
      return null
    }
  }

  /** The services this session may open, in the order the config declares them. */
  const availableTo = (user) =>
    config.services.filter(
      (service) => config.enabledServices.includes(service.key) && user.services.includes(service.key),
    )

  /**
   * The accounts, for the administration console.
   *
   * One list, because there is one list: since sign-in moved here, bdc and
   * marches each hold only a shadow row created the first time somebody
   * visited. Reading either of those would show who has *been* there, which is
   * a different question from who has access.
   *
   * Admin only, and gated on the same session every other service verifies.
   */
  app.get(
    '/admin/api/users',
    handle(async (req, res) => {
      const user = currentUser(req)
      if (!user) return res.status(401).json({ success: false, data: null, error: 'Not signed in' })
      if (user.role !== 'admin') return res.status(403).json({ success: false, data: null, error: 'Administrator access required' })

      const rows = await services.users.listAll()
      res.json({
        success: true,
        error: null,
        data: rows.map((row) => ({
          id: row.id,
          email: row.email,
          fullName: row.full_name,
          role: row.role,
          // Which spaces this account may open — the thing that is actually
          // decided here rather than in either service.
          services: servicesOf(row),
          isActive: Boolean(row.is_active),
          lastLoginAt: row.last_login_at,
          createdAt: row.created_at,
        })),
      })
    }),
  )

  /**
   * Creating an account, from the administration console.
   *
   * The password is returned once, in this response, and never again — it is
   * stored only as a bcrypt hash. An administrator has to pass it on, which is
   * the honest shape: a console that could show a password on demand would be
   * a console worth stealing.
   */
  app.post(
    '/admin/api/users',
    handle(async (req, res) => {
      const user = currentUser(req)
      if (!user) return res.status(401).json({ success: false, data: null, error: 'Not signed in' })
      if (user.role !== 'admin') return res.status(403).json({ success: false, data: null, error: 'Administrator access required' })

      // Generated here unless one was supplied, so the common path does not go
      // through somebody inventing a weak one under time pressure.
      const password = String(req.body?.password ?? '').trim() || randomPassword()
      const services_ = Array.isArray(req.body?.services)
        ? req.body.services
        : String(req.body?.services ?? 'bdc,marches')

      try {
        const created = await services.auth.register({
          email: req.body?.email,
          password,
          fullName: req.body?.fullName || null,
          role: req.body?.role === 'admin' ? 'admin' : 'user',
          services: Array.isArray(services_) ? services_.join(',') : services_,
        })
        res.status(201).json({ success: true, error: null, data: { ...created, password } })
      } catch (error) {
        const status = error.statusCode ?? 400
        res.status(status).json({ success: false, data: null, error: error.message })
      }
    }),
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

/**
 * A password nobody has to invent.
 *
 * Ambiguous characters are left out: these get read off a screen and typed
 * somewhere else, and an O that was a 0 is a support conversation.
 */
function randomPassword(length = 20) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = webcrypto.getRandomValues(new Uint32Array(length))
  return [...bytes].map((n) => alphabet[n % alphabet.length]).join('')
}

export { servicesOf }
