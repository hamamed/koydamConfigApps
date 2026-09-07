import { config } from '../../config/index.js'
import { ForbiddenError, UnauthorizedError } from '../../utils/errors.js'

/** Reads the JWT from the Authorization header, falling back to the session cookie. */
function extractToken(req) {
  const header = req.headers.authorization ?? ''
  if (header.startsWith('Bearer ')) return header.slice('Bearer '.length).trim()
  return req.cookies?.[config.auth.cookieName] ?? null
}

/**
 * Populates `req.user` when a valid token is present, without rejecting
 * anonymous traffic — used by public listing routes that decorate rows with
 * favourite state for signed-in callers.
 */
export function optionalAuth(auth) {
  return (req, _res, next) => {
    const token = extractToken(req)
    if (!token) return next()
    try {
      req.user = auth.verifyToken(token)
    } catch {
      req.user = null
    }
    next()
  }
}

/** Rejects anonymous requests. */
export function requireAuth(auth) {
  return (req, _res, next) => {
    try {
      req.user = auth.verifyToken(extractToken(req))
      next()
    } catch (error) {
      next(error)
    }
  }
}

/** Rejects anyone who is not an administrator. */
export function requireAdmin(auth) {
  const guard = requireAuth(auth)
  return (req, res, next) =>
    guard(req, res, (error) => {
      if (error) return next(error)
      if (req.user?.role !== 'admin') return next(new ForbiddenError('Administrator access required'))
      next()
    })
}

/**
 * HTML guards. These redirect to the login page rather than returning a JSON
 * 401, so the panel behaves like a normal web app.
 *
 * `requireUserPage` gates the screens any signed-in person may use — browsing
 * projects and keeping favourites. `requireAdminPage` gates the dashboard,
 * settings and account management, which can trigger crawls against a public
 * service and change how the whole site behaves.
 */
function pageGuard(auth, { adminOnly }) {
  return (req, res, next) => {
    try {
      const user = auth.verifyToken(extractToken(req))
      if (adminOnly && user.role !== 'admin') throw new ForbiddenError()
      req.user = user
      next()
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`)
      }
      // Signed in but not an administrator: send them where they can go, rather
      // than to a login form that would not help.
      if (error instanceof ForbiddenError) return res.redirect('/panel')
      next(error)
    }
  }
}

export const requireUserPage = (auth) => pageGuard(auth, { adminOnly: false })
export const requireAdminPage = (auth) => pageGuard(auth, { adminOnly: true })
