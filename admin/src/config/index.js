import dotenv from 'dotenv'

dotenv.config()

const DEFAULT_PORT = 3600
const MIN_PRODUCTION_SECRET_LENGTH = 32

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * The services this console administers.
 *
 * Each one is reached over its own `/admin/api`, with the signed-in person's
 * own session token — so a service still authorises the actual administrator
 * rather than a shared machine credential, and revoking somebody on the portal
 * closes this door too. Adding a service is an entry here and nothing else.
 */
const SERVICES = Object.freeze([
  Object.freeze({
    key: 'bdc',
    label: 'Bons de commande',
    api: (process.env.SERVICE_BDC_API || 'https://bdc.civictrust.ma').replace(/\/+$/, ''),
    panel: (process.env.SERVICE_BDC_URL || 'https://bdc.civictrust.ma/panel').replace(/\/+$/, ''),
  }),
  Object.freeze({
    key: 'marches',
    label: 'Marchés',
    api: (process.env.SERVICE_MARCHES_API || 'https://marches.civictrust.ma').replace(/\/+$/, ''),
    panel: (process.env.SERVICE_MARCHES_URL || 'https://marches.civictrust.ma/panel').replace(/\/+$/, ''),
  }),
])

export const config = Object.freeze({
  env: process.env.NODE_ENV || 'development',
  isProduction: (process.env.NODE_ENV || 'development') === 'production',
  port: int(process.env.PORT, DEFAULT_PORT),
  publicUrl: (process.env.PUBLIC_URL || 'https://admin.civictrust.ma').replace(/\/+$/, ''),

  auth: {
    // The same secret and cookie the portal issues; this console verifies, it
    // never signs. It has no accounts and no password of its own.
    jwtSecret: process.env.JWT_SECRET || 'insecure-development-secret',
    cookieName: process.env.AUTH_COOKIE_NAME || 'mp_token',
    portalUrl: (process.env.PORTAL_URL || 'https://portail.civictrust.ma').replace(/\/+$/, ''),
  },

  services: SERVICES,
  /** How long to wait on a service that is slow or down before saying so. */
  requestTimeoutMs: int(process.env.ADMIN_REQUEST_TIMEOUT_MS, 8000),

  logLevel: process.env.LOG_LEVEL || 'info',
})

/** @throws {Error} on a configuration that would be unsafe in production. */
export function assertConfigIsValid() {
  const problems = []
  if (config.isProduction) {
    if (config.auth.jwtSecret.length < MIN_PRODUCTION_SECRET_LENGTH) {
      problems.push(`JWT_SECRET must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production`)
    }
    if (config.auth.jwtSecret.startsWith('insecure-')) {
      problems.push('JWT_SECRET is still the development default')
    }
  }
  if (problems.length > 0) throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`)
}

/** @returns {object|undefined} the service with this key. */
export const serviceByKey = (key) => config.services.find((service) => service.key === key)
