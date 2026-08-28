import { composeTemplate, tidyPanel } from './compose.js';
import {
  buildGarmentPrompt,
  buildPrompt,
  checkPrompt,
  IDEAS_SYSTEM,
  parseIdeas,
  parsePlan,
  plannerSystem,
  PUBLISH_CHECKLIST,
  regionsFor,
  sizeForRegion,
} from './guidelines.js';
import { generateImage, isConfigured, isTextConfigured, streamPlan } from './provider.js';

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

export function isPlanningAvailable() {
  return isTextConfigured();
}

/**
 * Suggests distinct artwork ideas to start from.
 *
 * `theme` is optional — with nothing to go on it proposes a spread, which is
 * the point when the honest answer to "what do you want" is "something good".
 *
 * Text tokens only, nothing drawn, so browsing ideas costs a fraction of a
 * penny and rejecting all of them costs nothing.
 */
export async function suggestIdeas({ theme = '', category = 'shirt', count = 6 } = {}) {
  const wanted = Math.min(Math.max(Number(count) || 6, 3), 8);
  const subject = String(theme).trim();

  // A theme is checked before it is spent on. Without one there is nothing to
  // check: the model is bound by the rules in its own brief.
  if (subject) {
    const gate = checkPrompt(subject);
    if (!gate.ok) {
      const err = new Error(gate.reason);
      err.code = 'prompt_rejected';
      throw err;
    }
  }

  const garment = category === 'pants' ? 'trousers'
    : category === 'avatar' ? 'a full body outfit'
    : category === 'tshirt' ? 'a t-shirt'
    : 'a shirt';

  const ask = subject
    ? `Suggest ${wanted} artwork ideas for ${garment}, on the theme: ${subject}.`
    : `Suggest ${wanted} artwork ideas for ${garment}. Range widely.`;

  let text = '';
  for await (const delta of streamPlan([
    { role: 'system', content: IDEAS_SYSTEM },
    { role: 'user', content: ask },
  ])) {
    text += delta;
  }

  return parseIdeas(text);
}

/**
 * Plans the design in words, streaming as it is written.
 *
 * Costs text tokens and draws nothing, which is the entire point: this is the
 * step where "actually, make it colder" is free.
 *
 * `history` carries earlier turns so a follow-up is a correction rather than a
 * fresh start — the difference between talking to it and typing at it.
 */
export async function planDesign(
  { description, category = 'shirt', style = 'pattern', history = [] } = {},
  onDelta,
) {
  const gate = checkPrompt(description);
  if (!gate.ok) {
    const err = new Error(gate.reason);
    err.code = 'prompt_rejected';
    throw err;
  }

  const keys = style === 'garment'
    ? regionsFor(category)
    : ['front', 'back', 'pattern'];

  const messages = [
    { role: 'system', content: plannerSystem({ style, category }) },
    ...history,
    { role: 'user', content: `Garment: ${category}. Design: ${String(description).trim()}` },
  ];

  let text = '';
  for await (const delta of streamPlan(messages)) {
    text += delta;
    onDelta?.(delta);
  }

  return { text, ...parsePlan(text, keys) };
}

export function availableQualities() {
  return Object.keys(PIECES);
}

/**
 * The two things this can draw.
 *
 * `pattern` is artwork — a galaxy, a camo, a gradient — stretched over the
 * whole garment. `garment` is clothing: a panel per region, so the collar is at
 * the neck, the cuffs are at the wrists and the waistband is at the waist.
 *
 * They are different enough to need different art direction. Pattern mode
 * forbids collars and seams because its one image lands on every front face;
 * garment mode asks for them, on the panel that becomes that part of the body.
 */
export function availableStyles() {
  return ['pattern', 'garment'];
}

/** How many images a choice costs, so the page can say so before it is spent. */
export function pieceCount(style, quality, category) {
  return style === 'garment'
    ? regionsFor(category).length
    : (PIECES[quality] ?? PIECES.standard).length;
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
  /** 'pattern' for artwork stretched over the garment, 'garment' for real
   *  clothing drawn a panel at a time. */
  style = 'pattern',
  /** Per-piece art direction from an approved plan. Falls back to the built
   *  prompt for any piece the planner did not cover. */
  directions = null,
  /** Called before and after each image, so a caller can say which of the
   *  three minutes it is currently in. */
  onProgress = null,
} = {}) {
  const gate = checkPrompt(description);
  if (!gate.ok) {
    const err = new Error(gate.reason);
    err.code = 'prompt_rejected';
    throw err;
  }

  const garment = style === 'garment';

  // In garment mode the pieces are regions of a real garment and the set is
  // decided by what the category has to cover; in pattern mode they are the
  // richness the person asked for.
  const pieces = garment ? regionsFor(category) : (PIECES[quality] ?? PIECES.standard);
  const prompts = {};
  const art = {};

  for (const [index, piece] of pieces.entries()) {
    prompts[piece] = garment
      ? buildGarmentPrompt(description, {
        region: piece,
        category,
        direction: directions?.[piece] ?? null,
      })
      : buildPrompt(description, {
        face: piece,
        category,
        direction: directions?.[piece] ?? null,
      });

    onProgress?.({ stage: 'image', face: piece, index, total: pieces.length });

    // Sequential rather than parallel. Providers rate limit per minute, and a
    // 429 halfway through means paying for the pieces that did land and
    // getting nothing usable out of them.
    //
    // Garment panels are drawn at the proportion they will occupy. A sleeve is
    // half as wide as it is tall, and asking for a square meant a quarter of
    // every sleeve was drawn and then cropped off.
    const drawn = await generateImage(prompts[piece], {
      size: garment ? sizeForRegion(piece) : '1024x1024',
    });

    // Once per panel, not once per face: the same sleeve is composed onto six
    // of them, and a border removed six times is five wasted decodes.
    art[piece] = await tidyPanel(drawn);
  }

  onProgress?.({ stage: 'compose', total: pieces.length });
  const template = await composeTemplate(art, category, style);

  return {
    template,
    // The front-facing panel doubles as the card preview: it is the design as
    // drawn, before it was cut up and shaded across eighteen faces. Garment
    // mode has no `front`, so the chest — or the waist, on trousers — stands in.
    preview: art.front ?? art.chest ?? art.waist ?? art.legFront ?? art[pieces[0]],
    meta: {
      description: String(description).trim(),
      category,
      quality,
      style,
      pieces,
      prompts,
      // Kept so the skin page can answer "why does it look like this" months
      // later, when the only other record is the picture itself.
      directions: directions ?? null,
      generatedAt: new Date().toISOString(),
    },
    checklist: PUBLISH_CHECKLIST,
  };
}
