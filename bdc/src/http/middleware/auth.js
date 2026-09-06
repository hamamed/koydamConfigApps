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
 * HTML variant of {@link requireAdmin}: redirects to the login page instead of
 * returning a JSON 401, so the admin panel behaves like a normal web app.
 */
export function requireAdminPage(auth) {
  return (req, res, next) => {
    try {
      const user = auth.verifyToken(extractToken(req))
      if (user.role !== 'admin') throw new ForbiddenError()
      req.user = user
      next()
    } catch (error) {
      if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
        return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`)
      }
      next(error)
    }
  }
}
