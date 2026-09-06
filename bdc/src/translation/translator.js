import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { config } from '../config/index.js'
import { logger } from '../utils/logger.js'

const log = logger.child('[translate]')

/**
 * Translates the article breakdown of an avis.
 *
 * These are procurement specifications — "Rame de 500 feuilles", "Barrière
 * galvanisé 1er choix", unit names, marques and models — published in French
 * and occasionally Arabic. A general-purpose translator mangles them: the terms
 * are trade-specific and the numbers, references and model names inside them
 * must survive untouched or the line no longer describes what is being bought.
 * So the model gets told what the text is and what not to touch.
 */
const LANGUAGE_NAMES = { fr: 'French', en: 'English', ar: 'Arabic' }

/**
 * Articles are sent together rather than one per request. Terminology stays
 * consistent across a lot when the model sees the whole list, and it is one
 * round trip instead of seventy.
 */
const BATCH_SIZE = 25

const TranslationSchema = z.object({
  translations: z.array(
    z.object({
      id: z.number(),
      designation: z.string(),
      description: z.string(),
    }),
  ),
})

const systemPrompt = (target) => `You translate Moroccan public-procurement notices into ${LANGUAGE_NAMES[target]}.

The text is the article breakdown of a purchase-order notice: what a public body
wants to buy, line by line. It is written by procurement officers, mixes French
and Arabic, and is often terse and abbreviated.

Rules:
- Translate into ${LANGUAGE_NAMES[target]} only. Text already in that language is returned unchanged.
- Keep every number, quantity, dimension, reference, standard, brand and model exactly as written. "beneview t 6", "NAVIGATOR", "1er choix", "220V" and "A4" are not translated.
- Keep units of measure recognisable; expand an abbreviation only when it is unambiguous.
- Preserve the register. These are specifications, not prose: do not add words, explanations, marketing or pleasantries.
- If a line is meaningless or empty, return it unchanged rather than inventing content.
- Return a translation for every id you are given, and no others.`

export function createTranslator(options = {}) {
  const settings = { ...config.translation, ...options }
  let client = null

  const getClient = () => {
    if (!client) client = new Anthropic({ apiKey: settings.apiKey })
    return client
  }

  /**
   * @param {Array<{id: number, designation: string, description: string|null}>} articles
   * @param {'fr'|'en'|'ar'} target
   * @returns {Promise<{translations: Array<{id, designation, description}>, model: string}>}
   */
  async function translate(articles, target) {
    if (!settings.enabled) throw new Error('Translation is not configured')
    if (!LANGUAGE_NAMES[target]) throw new Error(`Unsupported language: ${target}`)

    const translations = []
    for (let start = 0; start < articles.length; start += BATCH_SIZE) {
      const batch = articles.slice(start, start + BATCH_SIZE)
      translations.push(...(await translateBatch(batch, target)))
    }
    return { translations, model: settings.model }
  }

  async function translateBatch(batch, target) {
    const payload = batch.map((article) => ({
      id: article.id,
      designation: article.designation ?? '',
      description: article.description ?? '',
    }))

    const response = await getClient().messages.parse({
      model: settings.model,
      max_tokens: 16000,
      system: systemPrompt(target),
      messages: [
        {
          role: 'user',
          content: `Translate these ${payload.length} article(s):\n\n${JSON.stringify(payload, null, 2)}`,
        },
      ],
      output_config: { format: zodOutputFormat(TranslationSchema) },
    })

    // A refusal or a schema miss leaves parsed_output null; treat it as a
    // failure rather than storing an empty translation over readable French.
    if (response.stop_reason === 'refusal') {
      throw new Error(`Translation declined: ${response.stop_details?.category ?? 'unknown'}`)
    }
    if (!response.parsed_output) throw new Error('Translation returned nothing usable')

    const byId = new Map(payload.map((article) => [article.id, article]))
    const usable = response.parsed_output.translations.filter((row) => byId.has(row.id))
    log.info('batch translated', {
      target,
      asked: payload.length,
      got: usable.length,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    })
    return usable
  }

  return { translate, isConfigured: () => settings.enabled, model: settings.model }
}
