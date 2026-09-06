import { NotFoundError, ValidationError } from '../utils/errors.js'
import { isSupported } from '../i18n/index.js'
import { logger } from '../utils/logger.js'

const log = logger.child('[translate]')

/**
 * Article translation for a consultation, cached per language.
 *
 * Only the articles are translated. The objet, the buyer's name and the
 * reference are left as published: they are how the avis is identified, and a
 * translated buyer name is not searchable against the portal.
 */
export function createTranslationService({ consultations, articles, translations, translator }) {
  /**
   * @param {number} consultationId
   * @param {string} locale target language
   * @returns {Promise<{locale, model, articles: Array, translated: number, cached: number}>}
   */
  async function translateConsultation(consultationId, locale) {
    if (!(await translator.isConfigured())) {
      throw new ValidationError('Translation is not configured on this server')
    }
    if (!isSupported(locale)) throw new ValidationError(`Unsupported language: ${locale}`)

    const consultation = await consultations.findById(consultationId)
    if (!consultation) throw new NotFoundError(`Consultation ${consultationId}`)

    const rows = await articles.findByConsultationId(consultationId)
    if (rows.length === 0) return { locale, model: null, articles: [], translated: 0, cached: 0 }

    const stored = await translations.findForArticles(rows.map((row) => row.id), locale)
    const missing = rows.filter((row) => !stored.has(row.id))

    let model = null
    if (missing.length > 0) {
      const result = await translator.translate(missing, locale)
      model = result.model
      for (const saved of await translations.saveMany(result.translations, locale, result.model)) {
        stored.set(saved.article_id, saved)
      }
      log.info('translated', { consultationId, locale, translated: missing.length, cached: rows.length - missing.length })
    }

    return {
      locale,
      model,
      translated: missing.length,
      cached: rows.length - missing.length,
      articles: rows.map((row) => ({
        id: row.id,
        // Falls back to the original when a line came back untranslated, rather
        // than showing an empty cell where readable French used to be.
        designation: stored.get(row.id)?.designation || row.designation,
        description: stored.get(row.id)?.description || row.description,
      })),
    }
  }

  const isConfigured = () => translator.isConfigured()

  return { translateConsultation, isConfigured }
}
