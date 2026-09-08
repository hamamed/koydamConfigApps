import { config } from '../../config/index.js'
import { ForbiddenError, UnauthorizedError } from '../../utils/errors.js'

/**
 * Authentication against the shared CivicTrust session.
 *
 * The token is issued by the portal and verified here with the same secret;
 * this service holds no password of its own any more. Because the token's `sub`
 * is the portal's row id and means nothing in this database, every guard
 * resolves it to a local row by email — which is why they are all async now.
 */

/** Reads the JWT from the Authorization header, falling back to the session cookie. */
function extractToken(req) {
  const header = req.headers.authorization ?? ''
  if (header.startsWith('Bearer ')) return header.slice('Bearer '.length).trim()
  return req.cookies?.[config.auth.cookieName] ?? null
}

/** Where an anonymous visitor is sent to sign in, and back to where they were. */
const signInUrl = (req) =>
  `${config.auth.portalUrl}/login?next=${encodeURIComponent(`${config.publicUrl}${req.originalUrl}`)}`

/**
 * Populates `req.user` when a valid session is present, without rejecting
 * anonymous traffic — used by public listings that decorate rows with
 * favourite state for signed-in callers.
 */
export function optionalAuth(auth) {
  return async (req, _res, next) => {
    const token = extractToken(req)
    if (!token) return next()
    try {
      req.user = await auth.resolveSession(token)
    } catch {
      req.user = null
    }
    next()
  }
}

/** Rejects anonymous requests. */
export function requireAuth(auth) {
  return async (req, _res, next) => {
    try {
      req.user = await auth.resolveSession(extractToken(req))
      next()
    } catch (error) {
      next(error)
    }
  }
}

/** Rejects anyone who is not an administrator. */
export function requireAdmin(auth) {
  return async (req, res, next) => {
    try {
      req.user = await auth.resolveSession(extractToken(req))
      if (req.user.role !== 'admin') throw new ForbiddenError('Administrator access required')
      next()
    } catch (error) {
      next(error)
    }
  }
}

/**
 * HTML guards. These redirect rather than returning a JSON 401, so the panel
 * behaves like a normal web app.
 *
 * `requireUserPage` gates the screens any signed-in person may use;
 * `requireAdminPage` gates the dashboard, settings and account management,
 * which change how the site behaves for everyone or send traffic at a public
 * government service.
 */
function pageGuard(auth, { adminOnly }) {
  return async (req, res, next) => {
    try {
      const user = await auth.resolveSession(extractToken(req))
      if (adminOnly && user.role !== 'admin') throw new ForbiddenError()
      req.user = user
      next()
    } catch (error) {
      // Signing in happens on the portal now, so an anonymous visitor leaves
      // this host entirely and comes back with a session that works here and
      // on every other CivicTrust service.
      if (error instanceof UnauthorizedError) return res.redirect(signInUrl(req))
      // Signed in but not an administrator: send them where they can go, rather
      // than to a sign-in form that would not help.
      if (error instanceof ForbiddenError) return res.redirect('/panel')
      next(error)
    }
  }
}

export const requireUserPage = (auth) => pageGuard(auth, { adminOnly: false })
export const requireAdminPage = (auth) => pageGuard(auth, { adminOnly: true })
