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

const COOKIE_MAX_AGE_MS = 12 * 60 * 60 * 1000

/** Session cookie settings shared by the JSON API and the admin panel. */
export const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: config.isProduction,
  maxAge: COOKIE_MAX_AGE_MS,
  path: '/',
}
