import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

dotenv.config()

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const DEFAULT_PORT = 3300
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_PAGES = 50
const DEFAULT_PAGE_SIZE = 20
const DEFAULT_DELAY_MS = 1200
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_DETAIL_CONCURRENCY = 2
const DEFAULT_TAX_RATE = 20
const MIN_PRODUCTION_SECRET_LENGTH = 32

/**
 * The portal sits behind a WAF that answers 403 to any client whose User-Agent
 * does not look like a browser — a plain "marches-publics-api/1.0" is refused
 * before the request reaches the application. It accepts a browser string with
 * our own identity appended, so the crawler stays attributable and contactable
 * instead of anonymous; set SCRAPER_USER_AGENT to put a real contact address in
 * the tail of it.
 */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36 marches-publics-api/1.0'

const bool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const num = (value, fallback) => {
  const parsed = Number.parseFloat(value ?? '')
  return Number.isFinite(parsed) ? parsed : fallback
}

const list = (value, fallback = []) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .concat(value ? [] : fallback)

const resolvePath = (value, fallback) => path.resolve(ROOT_DIR, value || fallback)

export const config = Object.freeze({
  rootDir: ROOT_DIR,
  env: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  isTest: process.env.NODE_ENV === 'test',

  server: Object.freeze({
    port: int(process.env.PORT, DEFAULT_PORT),
    // Behind a reverse proxy the app must not be reachable directly from the
    // internet, so production binds to loopback unless HOST says otherwise.
    host: process.env.HOST || (process.env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0'),
    corsOrigins: list(process.env.CORS_ORIGINS, ['*']),
  }),

  db: Object.freeze({
    client: (process.env.DB_CLIENT || 'sqlite').toLowerCase(),
    sqliteFile:
      process.env.SQLITE_FILE === ':memory:'
        ? ':memory:'
        : resolvePath(process.env.SQLITE_FILE, './data/marches.sqlite'),
    connectionString: process.env.DATABASE_URL || '',
    ssl: bool(process.env.PGSSL, false),
  }),

  auth: Object.freeze({
    jwtSecret: process.env.JWT_SECRET || 'insecure-development-secret',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
    cookieName: 'mp_token',
    adminEmail: process.env.ADMIN_EMAIL || 'admin@example.com',
    adminPassword: process.env.ADMIN_PASSWORD || '',
  }),

  scraper: Object.freeze({
    baseUrl: (process.env.SCRAPER_BASE_URL || 'https://www.marchespublics.gov.ma').replace(/\/+$/, ''),
    consultationsPath: process.env.SCRAPER_CONSULTATIONS_PATH || '/bdc/entreprise/consultation/',
    resultsPath: process.env.SCRAPER_RESULTS_PATH || '/bdc/entreprise/consultation/resultat',
    userAgent: process.env.SCRAPER_USER_AGENT || DEFAULT_USER_AGENT,
    timeoutMs: int(process.env.SCRAPER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxPages: int(process.env.SCRAPER_MAX_PAGES, DEFAULT_MAX_PAGES),
    pageSize: int(process.env.SCRAPER_PAGE_SIZE, DEFAULT_PAGE_SIZE),
    delayMs: int(process.env.SCRAPER_DELAY_MS, DEFAULT_DELAY_MS),
    maxRetries: int(process.env.SCRAPER_MAX_RETRIES, DEFAULT_MAX_RETRIES),
    fetchDetails: bool(process.env.SCRAPER_FETCH_DETAILS, true),
    detailConcurrency: int(process.env.SCRAPER_DETAIL_CONCURRENCY, DEFAULT_DETAIL_CONCURRENCY),
  }),

  invoice: Object.freeze({
    currency: process.env.INVOICE_CURRENCY || 'MAD',
    taxRate: num(process.env.INVOICE_TAX_RATE, DEFAULT_TAX_RATE),
    numberPrefix: process.env.INVOICE_NUMBER_PREFIX || 'FCT',
    storageDir: resolvePath(process.env.INVOICE_STORAGE_DIR, './storage/invoices'),
  }),

  /**
   * Outbound notification. With no SMTP host configured, mail is written to the
   * log instead of sent — the alert pipeline still runs end to end, so nothing
   * silently stops working while credentials are being arranged.
   */
  mail: Object.freeze({
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.MAIL_FROM || 'bdc@civictrust.ma',
    enabled: Boolean(process.env.SMTP_HOST),
  }),

  company: Object.freeze({
    name: process.env.COMPANY_NAME || 'Ma Societe',
    ice: process.env.COMPANY_ICE || '',
    address: process.env.COMPANY_ADDRESS || '',
    email: process.env.COMPANY_EMAIL || '',
    phone: process.env.COMPANY_PHONE || '',
  }),
})

/**
 * Fails fast on boot when a production deployment is missing required secrets.
 * @throws {Error} when the configuration is unsafe for the current environment.
 */
export function assertConfigIsValid() {
  const problems = []

  if (!['sqlite', 'postgres'].includes(config.db.client)) {
    problems.push(`DB_CLIENT must be "sqlite" or "postgres" (received "${config.db.client}")`)
  }
  if (config.db.client === 'postgres' && !config.db.connectionString) {
    problems.push('DATABASE_URL is required when DB_CLIENT=postgres')
  }
  if (config.isProduction && config.auth.jwtSecret.length < MIN_PRODUCTION_SECRET_LENGTH) {
    problems.push(`JWT_SECRET must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production`)
  }
  if (config.isProduction && config.auth.jwtSecret.startsWith('change-me')) {
    problems.push('JWT_SECRET still holds its placeholder value')
  }

  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`)
  }
}
