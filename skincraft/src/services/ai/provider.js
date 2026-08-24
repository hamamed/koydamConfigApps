import { config } from '../../config.js';

/**
 * Generating the artwork.
 *
 * Speaks the OpenAI images API, which several providers implement - so
 * pointing AI_IMAGE_BASE_URL at a compatible endpoint switches provider
 * without touching this file. Anthropic models do not generate images, so this
 * is deliberately somebody else's API.
 *
 * Configuration:
 *
 *   AI_IMAGE_API_KEY      required; absent means the feature is simply off
 *   AI_IMAGE_BASE_URL     default https://api.openai.com/v1
 *   AI_IMAGE_MODEL        default gpt-image-1
 *
 * Off by default and honest about it: a generator that silently produces
 * nothing is harder to diagnose than one that says it has no key.
 */

const TIMEOUT_MS = 120_000;

export function isConfigured() {
  return Boolean(config.ai?.apiKey);
}

/**
 * One square image, as a PNG buffer.
 *
 * Square because every rectangle it will be scaled into is either square or
 * close to it, and a wide source cropped to a 64x128 sleeve loses most of
 * itself. 1024 because the largest face it fills is 128px - anything bigger is
 * paying for pixels that get thrown away.
 */
export async function generateImage(prompt, { size = '1024x1024' } = {}) {
  if (!isConfigured()) {
    throw new Error(
      'Image generation is not configured. Set AI_IMAGE_API_KEY to switch it on.',
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${config.ai.baseUrl}/images/generations`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify({
        model: config.ai.model,
        prompt,
        n: 1,
        size,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');

      // The provider's own safety system refusing is not a fault to retry; it
      // is an answer, and the person asking should be told which it was.
      if (res.status === 400 && /safety|policy|content/i.test(detail)) {
        throw new Error(
          'The image provider refused this prompt on content grounds. Try describing it differently.',
        );
      }

      if (res.status === 429) {
        throw new Error('The image provider is rate limiting. Wait a moment and try again.');
      }

      throw new Error(`Image provider returned ${res.status}. ${detail.slice(0, 200)}`);
    }

    const body = await res.json();
    const first = body?.data?.[0];

    if (first?.b64_json) return Buffer.from(first.b64_json, 'base64');

    // Some providers return a URL instead of bytes. Fetched here so the rest
    // of the pipeline only ever deals in buffers.
    if (first?.url) {
      const img = await fetch(first.url, { signal: controller.signal });
      if (!img.ok) throw new Error(`Could not download the generated image (${img.status}).`);
      return Buffer.from(await img.arrayBuffer());
    }

    throw new Error('The image provider returned no image.');
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('The image provider took too long. Try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
