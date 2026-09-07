import { config } from '../config/index.js'
import { logger } from '../utils/logger.js'

const log = logger.child('[translate]')

const ENDPOINT = 'https://translation.googleapis.com/language/translate/v2'

/**
 * Translates the article breakdown of an avis, via the Google Cloud Translation
 * API (v2, API-key auth — v3 needs a service account and OAuth).
 *
 * Two segments per article, designation and description, sent together. The API
 * takes an array and answers in the same order, so a whole lot is one request
 * rather than one per line.
 */
const LANGUAGES = new Set(['fr', 'en', 'ar'])

/**
 * Batch limits. The API accepts 128 segments per call; the practical ceiling is
 * the request body, so segments are also capped by total characters — a lot of
 * seventy articles with long specifications would otherwise exceed it.
 */
const MAX_SEGMENTS = 100
const MAX_CHARS = 8000

/**
 * Google returns HTML entities even with `format=text` — an apostrophe comes
 * back as `&#39;`, which is most of them in French. Left alone they render as
 * literal `&#39;` in the table.
 */
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }
const decodeEntities = (text) =>
  String(text ?? '')
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity])
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))

/**
 * @param {object} [options]
 * @param {() => Promise<{apiKey: string}>} [options.resolve] reads the current
 *   key. Called per request, so a key saved in the panel takes effect on the
 *   next translation rather than on the next restart.
 */
export function createTranslator(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const resolve =
    options.resolve ??
    (async () => ({ apiKey: options.apiKey ?? config.translation.apiKey }))

  const current = async () => {
    const resolved = await resolve()
    const apiKey = String(resolved?.apiKey ?? '').trim()
    return { apiKey, enabled: options.enabled ?? Boolean(apiKey) }
  }

  /**
   * @param {Array<{id: number, designation: string, description: string|null}>} articles
   * @param {'fr'|'en'|'ar'} target
   * @returns {Promise<{translations: Array<{id, designation, description}>, model: string}>}
   */
  async function translate(articles, target) {
    const settings = await current()
    if (!settings.enabled) throw new Error('Translation is not configured')
    if (!LANGUAGES.has(target)) throw new Error(`Unsupported language: ${target}`)

    // Two segments per article, kept in a flat list so one response maps back
    // by position. Empty strings are not sent — the API bills per character and
    // would return an empty string anyway.
    const segments = []
    for (const article of articles) {
      for (const field of ['designation', 'description']) {
        const text = String(article[field] ?? '').trim()
        if (text) segments.push({ id: article.id, field, text })
      }
    }

    const translated = new Map()
    for (const batch of batches(segments)) {
      const results = await translateBatch(batch.map((segment) => segment.text), target, settings.apiKey)
      batch.forEach((segment, index) => {
        translated.set(`${segment.id}:${segment.field}`, results[index] ?? segment.text)
      })
    }

    return {
      model: `google-translate-v2:${target}`,
      translations: articles.map((article) => ({
        id: article.id,
        designation: translated.get(`${article.id}:designation`) ?? article.designation ?? '',
        description: translated.get(`${article.id}:description`) ?? article.description ?? '',
      })),
    }
  }

  /** Splits by both segment count and total characters. */
  function* batches(segments) {
    let current = []
    let chars = 0
    for (const segment of segments) {
      if (current.length > 0 && (current.length >= MAX_SEGMENTS || chars + segment.text.length > MAX_CHARS)) {
        yield current
        current = []
        chars = 0
      }
      current.push(segment)
      chars += segment.text.length
    }
    if (current.length > 0) yield current
  }

  async function translateBatch(texts, target, apiKey) {
    const response = await fetchImpl(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: texts, target, format: 'text' }),
    })

    if (!response.ok) {
      // The API puts the useful part in the body, not the status line. The key
      // is in the URL, so nothing from the request is echoed into the message.
      const detail = await response.text().catch(() => '')
      const message = safeParse(detail)?.error?.message ?? `HTTP ${response.status}`
      throw new Error(`Google Translate refused the request: ${message}`)
    }

    const payload = await response.json()
    const rows = payload?.data?.translations
    if (!Array.isArray(rows) || rows.length !== texts.length) {
      throw new Error('Google Translate returned an unexpected number of segments')
    }

    log.info('batch translated', { target, segments: texts.length, chars: texts.join('').length })
    return rows.map((row) => decodeEntities(row.translatedText))
  }

  const safeParse = (value) => {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }

  const isConfigured = async () => (await current()).enabled

  return { translate, isConfigured, model: 'google-translate-v2' }
}
