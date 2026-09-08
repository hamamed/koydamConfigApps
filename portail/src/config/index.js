import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

dotenv.config()

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_PORT = 3500
const MIN_PRODUCTION_SECRET_LENGTH = 32

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const list = (value, fallback = []) =>
  String(value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .concat(String(value ?? '').trim() ? [] : fallback)

const resolvePath = (value, fallback) => path.resolve(ROOT_DIR, value || fallback)

/**
 * The services this portal is the front door for.
 *
 * Each entry is what the chooser renders and where it sends people. Adding one
 * is an entry here plus a line in `PORTAL_SERVICES`; nothing else in the portal
 * knows the list.
 */
const SERVICES = Object.freeze([
  Object.freeze({
    key: 'bdc',
    url: process.env.SERVICE_BDC_URL || 'https://bdc.civictrust.ma/panel',
    icon: 'receipt',
  }),
  Object.freeze({
    key: 'marches',
    url: process.env.SERVICE_MARCHES_URL || 'https://marches.civictrust.ma/panel',
    icon: 'gavel',
  }),
])

export const config = Object.freeze({
  env: process.env.NODE_ENV || 'development',
  isProduction: (process.env.NODE_ENV || 'development') === 'production',
  port: int(process.env.PORT, DEFAULT_PORT),
  publicUrl: (process.env.PUBLIC_URL || 'https://portail.civictrust.ma').replace(/\/+$/, ''),

  db: {
    client: process.env.DATABASE_URL ? 'postgres' : 'sqlite',
    connectionString: process.env.DATABASE_URL || null,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    // `:memory:` is passed through untouched — resolving it against the project
    // root would turn it into a file called ":memory:" and the tests would
    // silently share state through it.
    sqliteFile:
      process.env.SQLITE_FILE === ':memory:'
        ? ':memory:'
        : resolvePath(process.env.SQLITE_FILE, './data/portail.sqlite'),
  },

  auth: {
    jwtSecret: process.env.JWT_SECRET || 'insecure-development-secret',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
    // The same cookie name every service on this domain already reads.
    cookieName: process.env.AUTH_COOKIE_NAME || 'mp_token',
    /**
     * The one setting that makes a single login work.
     *
     * A cookie with no Domain is sent back only to the host that set it, so a
     * session opened here would never reach bdc or marches. Set to
     * ".civictrust.ma" it is sent to every host under it — which is also why
     * the three services must share JWT_SECRET: each verifies the same token
     * rather than issuing its own.
     *
     * Left empty in development, where everything is 127.0.0.1 and a domain
     * attribute would make the browser drop the cookie entirely.
     */
    cookieDomain: process.env.AUTH_COOKIE_DOMAIN || null,
  },

  services: SERVICES,
  /** Which of the above are offered at all, independent of who may open them. */
  enabledServices: list(process.env.PORTAL_SERVICES, ['bdc', 'marches']),

  mail: {
    host: process.env.SMTP_HOST || null,
    port: int(process.env.SMTP_PORT, 587),
    user: process.env.SMTP_USER || null,
    password: process.env.SMTP_PASSWORD || null,
    from: process.env.MAIL_FROM || 'portail@civictrust.ma',
  },

  logLevel: process.env.LOG_LEVEL || 'info',
})

/**
 * Fails fast on a configuration that would be unsafe in production, rather than
 * booting and issuing tokens anyone can forge.
 * @throws {Error}
 */
export function assertConfigIsValid() {
  const problems = []

  if (config.isProduction) {
    if (config.auth.jwtSecret.length < MIN_PRODUCTION_SECRET_LENGTH) {
      problems.push(`JWT_SECRET must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production`)
    }
    if (config.auth.jwtSecret.startsWith('insecure-')) {
      problems.push('JWT_SECRET is still the development default')
    }
    // A shared session that is not shared is the whole feature failing silently:
    // people would sign in here and be bounced straight back by bdc.
    if (!config.auth.cookieDomain) {
      problems.push('AUTH_COOKIE_DOMAIN must be set in production, or the session never reaches the other services')
    }
  }

  if (problems.length > 0) throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`)
}
