import { composeTemplate } from './compose.js';
import { buildPrompt, checkPrompt, PUBLISH_CHECKLIST } from './guidelines.js';
import { generateImage, isConfigured } from './provider.js';

/**
 * Designing a skin from a description.
 *
 * The order matters and each step exists to protect the next:
 *
 *   1. Check the request against Roblox's content rules, before spending
 *      anything. A provider refusal costs the same as a success.
 *   2. Generate flat artwork - not a template. The model is told repeatedly
 *      not to draw a garment, because its instinct is to draw a picture of a
 *      shirt, which would then be printed on a shirt.
 *   3. Compose that artwork into the verified UV rectangles.
 *   4. Hand back a draft. Nothing is published: Roblox moderates on upload and
 *      a person has to look at this before it is offered to anyone.
 */

/** How many images to generate for a given richness. Each one costs money. */
const PIECES = {
  // One image, reused on every face with per-face shading. The cheapest
  // usable result, and for a bold graphic it is often the right one.
  simple: ['front'],
  // Front and a matching back. What most clothing actually wants.
  standard: ['front', 'back'],
  // Plus a quieter pattern for sleeves and sides, so they read as fabric
  // rather than as three more copies of the chest design.
  detailed: ['front', 'back', 'pattern'],
};

export function isAvailable() {
  return isConfigured();
}

export function availableQualities() {
  return Object.keys(PIECES);
}

/**
 * Generates and composes. Returns the finished sheet plus what was used to
 * make it, so the panel can show its work and the record can say what was
 * asked for.
 */
export async function designSkin({
  description,
  category = 'shirt',
  quality = 'standard',
} = {}) {
  const gate = checkPrompt(description);
  if (!gate.ok) {
    const err = new Error(gate.reason);
    err.code = 'prompt_rejected';
    throw err;
  }

  const pieces = PIECES[quality] ?? PIECES.standard;
  const prompts = {};
  const art = {};

  for (const face of pieces) {
    prompts[face] = buildPrompt(description, { face, category });

    // Sequential rather than parallel. Providers rate limit per minute, and a
    // 429 halfway through means paying for the pieces that did land and
    // getting nothing usable out of them.
    art[face] = await generateImage(prompts[face]);
  }

  const template = await composeTemplate(art, category);

  return {
    template,
    // The front artwork doubles as the card preview: it is the design as
    // drawn, before it was cut up and shaded across eighteen faces.
    preview: art.front,
    meta: {
      description: String(description).trim(),
      category,
      quality,
      pieces,
      prompts,
      generatedAt: new Date().toISOString(),
    },
    checklist: PUBLISH_CHECKLIST,
  };
}
