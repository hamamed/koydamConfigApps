import { config } from '../config/index.js'

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000

/**
 * The shared session cookie.
 *
 * `domain` is what makes one sign-in reach three services: without it the
 * browser returns the cookie only to the host that set it, and a session opened
 * on the portal would be invisible to bdc and marches. It is read from config
 * rather than hardcoded because in development everything is 127.0.0.1, where a
 * domain attribute makes the browser drop the cookie outright.
 *
 * `sameSite: 'lax'` rather than 'strict': the whole point is arriving at
 * another host by following a link, and 'strict' withholds the cookie on
 * exactly that navigation — the user would land on bdc signed out.
 */
export const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: config.isProduction,
  maxAge: TWELVE_HOURS_MS,
  path: '/',
  ...(config.auth.cookieDomain ? { domain: config.auth.cookieDomain } : {}),
})

/**
 * Clearing must repeat the domain and path the cookie was set with. A
 * `clearCookie` that omits them removes a different cookie — one scoped to this
 * host — and leaves the shared session in place, so "sign out" would appear to
 * work here and change nothing on the other two services.
 */
export const clearCookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: config.isProduction,
  path: '/',
  ...(config.auth.cookieDomain ? { domain: config.auth.cookieDomain } : {}),
})
