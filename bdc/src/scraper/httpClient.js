import { config } from '../config/index.js'
import { ScraperError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

const log = logger.child('[scraper:http]')
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])
const BACKOFF_BASE_MS = 800

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Small polite HTTP client for the portal.
 *
 * The portal is a Symfony application that hands out a session cookie on the
 * first GET and expects it back on every subsequent request (including the
 * paginated filter requests), so a cookie jar is not optional here.
 */
export function createHttpClient(options = {}) {
  const {
    baseUrl = config.scraper.baseUrl,
    fetchImpl = globalThis.fetch,
    // Optional: reads the live values before each request, so the panel's
    // throttle and user-agent settings apply without a restart.
    resolveOptions = null,
  } = options

  const defaults = {
    userAgent: options.userAgent ?? config.scraper.userAgent,
    timeoutMs: options.timeoutMs ?? config.scraper.timeoutMs,
    delayMs: options.delayMs ?? config.scraper.delayMs,
    maxRetries: options.maxRetries ?? config.scraper.maxRetries,
  }

  const current = async () => (resolveOptions ? { ...defaults, ...(await resolveOptions()) } : defaults)

  const cookies = new Map()
  let lastRequestAt = 0

  const cookieHeader = () =>
    [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ')

  const storeCookies = (response) => {
    const raw = response.headers.getSetCookie?.() ?? []
    for (const entry of raw) {
      const [pair] = entry.split(';')
      const separator = pair.indexOf('=')
      if (separator === -1) continue
      cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim())
    }
  }

  /** Honours the configured politeness delay between two outbound requests. */
  const throttle = async (delayMs) => {
    const elapsed = Date.now() - lastRequestAt
    if (lastRequestAt > 0 && elapsed < delayMs) await sleep(delayMs - elapsed)
    lastRequestAt = Date.now()
  }

  const absolute = (url) => (url.startsWith('http') ? url : `${baseUrl}${url.startsWith('/') ? '' : '/'}${url}`)

  /**
   * GETs a page and returns its HTML, retrying transient failures with
   * exponential backoff.
   * @param {string} url absolute URL or path relative to the portal base.
   * @param {URLSearchParams|object} [params] query string parameters.
   */
  async function getHtml(url, params) {
    const target = new URL(absolute(url))
    if (params) {
      const search = params instanceof URLSearchParams ? params : new URLSearchParams(params)
      for (const [key, value] of search.entries()) target.searchParams.append(key, value)
    }

    const { userAgent, timeoutMs, delayMs, maxRetries } = await current()
    let lastError = null

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      await throttle(delayMs)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        log.debug('GET', { url: target.toString(), attempt })
        const response = await fetchImpl(target, {
          method: 'GET',
          redirect: 'follow',
          signal: controller.signal,
          headers: {
            'User-Agent': userAgent,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'fr-FR,fr;q=0.9,ar;q=0.8,en;q=0.7',
            ...(cookies.size > 0 ? { Cookie: cookieHeader() } : {}),
          },
        })
        storeCookies(response)

        if (!response.ok) {
          const error = new ScraperError(`HTTP ${response.status} for ${target}`, { status: response.status })
          if (!RETRYABLE_STATUSES.has(response.status)) throw error
          lastError = error
        } else {
          return { html: await response.text(), url: response.url || target.toString() }
        }
      } catch (error) {
        if (error instanceof ScraperError && !RETRYABLE_STATUSES.has(error.details?.status)) throw error
        lastError = error
      } finally {
        clearTimeout(timer)
      }

      if (attempt < maxRetries) {
        const backoff = BACKOFF_BASE_MS * 2 ** (attempt - 1)
        log.warn('retrying', { url: target.toString(), attempt, backoff, reason: lastError?.message })
        await sleep(backoff)
      }
    }

    throw new ScraperError(`Failed to fetch ${target} after ${maxRetries} attempts`, {
      cause: lastError?.message,
    })
  }

  return { getHtml, absolute, cookies }
}
