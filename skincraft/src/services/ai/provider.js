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
 * Whether the planning step is available.
 *
 * Separate from `isConfigured` because it is a different model on the same
 * key: an install can generate images without ever planning in words, and
 * should keep working if the text model is unset or withdrawn.
 */
export function isTextConfigured() {
  return Boolean(config.ai?.apiKey && config.ai?.textModel);
}

/**
 * Streams a chat completion, yielding text as it is written.
 *
 * The point of streaming here is not speed — it is that the plan is the one
 * part of this pipeline a person can still change their mind about. Watching
 * it arrive is what makes it feel like something you can interrupt, rather
 * than a paragraph that appears once the decision has already been made.
 *
 * Yields deltas; returns nothing. The caller accumulates, because it is the
 * caller that knows whether it wants the whole thing or just to forward it.
 */
/**
 * Which name this provider gives the output cap.
 *
 * OpenAI renamed `max_tokens` to `max_completion_tokens` and its newer models
 * reject the old one outright; plenty of OpenAI-compatible endpoints only know
 * the old one. The base URL here is deliberately configurable, so neither can
 * be assumed — the first rejection settles it and the answer is remembered for
 * the life of the process.
 */
let tokenLimitParam = 'max_tokens';

/** Enough for a plan and the three prompts; past this it is padding, and
 *  padding is what turns a plan into something nobody reads. */
const PLAN_TOKEN_LIMIT = 700;

async function requestPlan(messages, signal) {
  return fetch(`${config.ai.baseUrl}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.ai.apiKey}`,
    },
    body: JSON.stringify({
      model: config.ai.textModel,
      messages,
      stream: true,
      [tokenLimitParam]: PLAN_TOKEN_LIMIT,
    }),
  });
}

export async function* streamPlan(messages, { signal } = {}) {
  if (!isTextConfigured()) {
    throw new Error(
      'Design planning is not configured. Set AI_TEXT_MODEL to switch it on.',
    );
  }

  let res = await requestPlan(messages, signal);

  if (!res.ok) {
    let detail = await res.text().catch(() => '');

    // The provider told us the name it wants. Switching and retrying once is
    // better than making someone read a parameter name out of an error and go
    // looking for a setting that does not exist.
    const other = tokenLimitParam === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
    if (res.status === 400 && detail.includes(other)) {
      tokenLimitParam = other;
      res = await requestPlan(messages, signal);
      if (!res.ok) detail = await res.text().catch(() => '');
    }

    if (!res.ok) {
      throw new Error(`Planner returned ${res.status}. ${detail.slice(0, 200)}`);
    }
  }

  // Server-sent events, decoded by hand: `data: {json}` per line, `[DONE]` to
  // finish. A chunk can split mid-line, so the tail is carried over rather
  // than parsed — dropping it loses whole words at random.
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;

      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') return;

      try {
        const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // A malformed chunk is one lost word, not a reason to abandon a plan
        // that is otherwise arriving fine.
      }
    }
  }
}

/**
 * One square image, as a PNG buffer.
 *
 * Square because every rectangle it will be scaled into is either square or
 * close to it, and a wide source cropped to a 64x128 sleeve loses most of
 * itself. 1024 because the largest face it fills is 128px - anything bigger is
 * paying for pixels that get thrown away.
 */
/**
 * Sizes this provider has already refused, so a panel shape it cannot draw
 * costs one rejection rather than one per image for the rest of time.
 */
const refusedSizes = new Set();

export async function generateImage(prompt, { size = '1024x1024' } = {}) {
  if (!isConfigured()) {
    throw new Error(
      'Image generation is not configured. Set AI_IMAGE_API_KEY to switch it on.',
    );
  }

  // Every provider that implements this API draws a square; the portrait sizes
  // are newer and not universal. Falling back costs a crop, which is what this
  // did everywhere before — failing outright would cost the whole design.
  if (refusedSizes.has(size)) size = '1024x1024';

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

      // A size this provider does not offer. Remember it and draw the square.
      if (res.status === 400 && /size|dimension/i.test(detail) && size !== '1024x1024') {
        refusedSizes.add(size);
        clearTimeout(timer);
        return generateImage(prompt, { size: '1024x1024' });
      }

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

/**
 * Draws from a reference picture rather than from words alone.
 *
 * A different endpoint from `generateImage`: `/images/edits` takes multipart
 * with the picture attached, where `/images/generations` is JSON and text-only.
 * Same model and key, so a working setup needs nothing extra switched on.
 *
 * The prompt still matters — it says what to do with the reference. Without one
 * the provider guesses, and what it guesses is rarely a garment template.
 */
export async function generateImageFromReference(prompt, reference, { size = '1024x1024' } = {}) {
  if (!isConfigured()) {
    throw new Error(
      'Image generation is not configured. Set AI_IMAGE_API_KEY to switch it on.',
    );
  }
  if (!Buffer.isBuffer(reference) || reference.length === 0) {
    throw new Error('No reference image was given.');
  }

  if (refusedSizes.has(size)) size = '1024x1024';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const form = new FormData();
    form.append('model', config.ai.model);
    form.append('prompt', prompt);
    form.append('n', '1');
    form.append('size', size);
    // PNG regardless of what came in: storeTemplate re-encodes uploads with
    // sharp before they reach here, so the bytes are a PNG whatever the person
    // originally picked.
    form.append('image', new Blob([reference], { type: 'image/png' }), 'reference.png');

    const res = await fetch(`${config.ai.baseUrl}/images/edits`, {
      method: 'POST',
      signal: controller.signal,
      // No Content-Type header: fetch sets it, with the multipart boundary that
      // a hand-written one would omit.
      headers: { Authorization: `Bearer ${config.ai.apiKey}` },
      body: form,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');

      if (res.status === 400 && /size|dimension/i.test(detail) && size !== '1024x1024') {
        refusedSizes.add(size);
        clearTimeout(timer);
        return generateImageFromReference(prompt, reference, { size: '1024x1024' });
      }

      // Worth its own message: a reference of a real person or a recognisable
      // character is the common way this endpoint refuses, and "try describing
      // it differently" is unhelpful when the problem is the picture.
      if (res.status === 400 && /safety|policy|content|moderation/i.test(detail)) {
        throw new Error(
          'The image provider refused this reference on content grounds. Try a different picture.',
        );
      }

      if (res.status === 404) {
        throw new Error(
          'This provider has no /images/edits endpoint, so it cannot draw from a reference.',
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
