import rateLimit from 'express-rate-limit'
import { config } from '../../config/index.js'

const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_MAX_ATTEMPTS = 10
const API_WINDOW_MS = 60_000
const API_MAX_REQUESTS = 300

/**
 * Brute-force guard for the credential endpoints.
 *
 * Created per router rather than shared at module scope: a module-level limiter
 * would leak its counters between application instances (and between tests).
 */
export const createLoginLimiter = () =>
  rateLimit({
    windowMs: LOGIN_WINDOW_MS,
    limit: LOGIN_MAX_ATTEMPTS,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, data: null, error: 'Too many login attempts, please retry later' },
  })

export const createApiLimiter = () =>
  rateLimit({ windowMs: API_WINDOW_MS, limit: API_MAX_REQUESTS, standardHeaders: true, legacyHeaders: false })

/**
 * The public access-request form.
 *
 * Far tighter than the API limiter: a person fills this in once. The window is
 * long because the abuse it guards against is a script working through a list
 * of addresses, not somebody mistyping their own.
 */
export const createAccessRequestLimiter = () =>
  rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, data: null, error: 'Too many requests from this address, please retry later' },
  })

const COOKIE_MAX_AGE_MS = 12 * 60 * 60 * 1000

/** Session cookie settings shared by the JSON API and the admin panel. */
export const cookieOptions = {
  httpOnly: true,
  // 'lax', not 'strict': arriving here by following a link from the portal is
  // the normal path, and 'strict' withholds the cookie on exactly that
  // navigation — the visitor would land signed out.
  sameSite: 'lax',
  secure: config.isProduction,
  maxAge: COOKIE_MAX_AGE_MS,
  path: '/',
  ...(config.auth.cookieDomain ? { domain: config.auth.cookieDomain } : {}),
}

/**
 * Clearing has to repeat the domain and path the cookie was set with. Omitting
 * them clears a different cookie — one scoped to this host — and leaves the
 * shared session in place, so signing out here would sign you out of nothing.
 */
export const clearCookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: config.isProduction,
  path: '/',
  ...(config.auth.cookieDomain ? { domain: config.auth.cookieDomain } : {}),
}
