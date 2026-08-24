/**
 * What Roblox will and will not accept, encoded once.
 *
 * Two separate jobs live here, and conflating them is how a generator ends up
 * either useless or dangerous:
 *
 *   1. Technical rules - a classic shirt is a 585x559 PNG with the artwork in
 *      specific rectangles. These are not preferences; a template that ignores
 *      them wraps onto the avatar wrong and gets reported as "misaligned".
 *
 *   2. Content rules - what Roblox's moderators reject. Getting this wrong
 *      costs the upload fee, and repeatedly getting it wrong costs the account.
 *
 * The blocklist below is deliberately narrow. It catches the requests that are
 * obviously against Roblox's rules before spending money generating them, and
 * leaves everything else to the image provider's own safety system and to the
 * human who has to press publish. A long keyword list would block "black
 * dress" and "shooting star" while missing anything phrased carefully - the
 * appearance of safety without the substance.
 */

/**
 * Categories of request Roblox rejects outright.
 *
 * Each entry is a family of patterns and the reason, so the person typing gets
 * told what is wrong rather than a bare refusal they will try to work around.
 */
const REFUSALS = [
  {
    reason: 'Roblox removes clothing that depicts real brands or their logos.',
    patterns: [
      /\b(nike|adidas|gucci|supreme|louis\s*vuitton|chanel|balenciaga|puma|reebok|off[-\s]?white|versace|prada|burberry|fendi)\b/i,
      /\b(disney|marvel|pokemon|nintendo|minecraft|fortnite|among\s*us)\b/i,
    ],
  },
  {
    reason:
      'Clothing that depicts a real person is not allowed, including public figures.',
    patterns: [
      /\b(celebrity|real\s+person|photo\s+of\s+(a\s+)?(man|woman|person|someone))\b/i,
    ],
  },
  {
    reason: 'Roblox does not allow blood, gore or graphic violence on clothing.',
    // 'blood' alone blocks 'blood orange'. Gore needs the context that
    // makes it gore, not the word on its own.
    patterns: [
      /\b(gore|gory|bloody|bleeding|mutilat|decapitat|corpse|dismember)\b/i,
      /\bblood\s*(splatter|spatter|stain|drip|spray|soaked)/i,
    ],
  },
  {
    reason: 'Roblox does not allow revealing or suggestive clothing designs.',
    patterns: [
      /\b(nude|naked|nsfw|lingerie|underwear|bikini|thong|topless|explicit|sexy|seductive)\b/i,
    ],
  },
  {
    reason:
      'Roblox does not allow drug, alcohol, tobacco or weapon imagery on clothing.',
    patterns: [
      /\b(cannabis|marijuana|weed\s+leaf|cocaine|heroin|meth|syringe)\b/i,
      /\b(cigarette|vape|beer|whisk[ey]y|vodka|alcohol\s+brand)\b/i,
      /\b(gun|rifle|pistol|firearm|ak-?47|glock)\b/i,
    ],
  },
  {
    reason:
      'Hate symbols and extremist imagery are removed and can cost the account.',
    patterns: [/\b(swastika|nazi|kkk|hate\s+symbol|white\s+power)\b/i],
  },
  {
    reason:
      'Clothing may not carry contact details, links, or off-platform trading.',
    patterns: [
      /\b(discord\.gg|https?:\/\/|www\.|@[a-z0-9_]{3,}|snapchat|whatsapp)\b/i,
      /\b(free\s+robux|robux\s+generator|giveaway\s+scam)\b/i,
    ],
  },
];

/**
 * Whether this request is worth sending to a generator.
 *
 * Returns `{ ok }` or `{ ok: false, reason }`. Checked before spending money,
 * not after - a provider refusal costs the same as a success.
 */
export function checkPrompt(prompt) {
  const text = String(prompt ?? '').trim();

  if (text.length < 3) {
    return { ok: false, reason: 'Describe the design in a few words.' };
  }

  if (text.length > 500) {
    return {
      ok: false,
      reason: 'Keep it under 500 characters - long prompts drift off the brief.',
    };
  }

  for (const rule of REFUSALS) {
    if (rule.patterns.some((p) => p.test(text))) {
      return { ok: false, reason: rule.reason };
    }
  }

  return { ok: true };
}

/**
 * The rules an image model has to be told, because it cannot know them.
 *
 * Every line here exists because its absence produced something unusable:
 * a model asked for "a shirt design" draws a shirt-shaped object with sleeves
 * and a collar, which then appears as a picture of a shirt printed on a shirt.
 * What is wanted is the fabric, flat, edge to edge.
 */
const ART_DIRECTION = [
  'Flat 2D texture artwork only.',
  'Do NOT draw a shirt, a garment, a mannequin, a person, or a body.',
  'No sleeves, collar, neckline, buttons, seams or folds.',
  'Fill the entire square edge to edge - no borders, margins, or drop shadow.',
  'No background colour behind a smaller design; the artwork IS the whole square.',
  'No text, letters, numbers, watermarks or signatures.',
  'Bold shapes and strong colours - this is displayed small, at 128 pixels wide.',
  'Even, flat lighting. No photographic depth of field or 3D rendering.',
].join(' ');

/**
 * Turns a person's description into a prompt for a texture.
 *
 * The face matters: the front of a torso is a focal design, while a sleeve is
 * a continuation of it. Asking for the same artwork for both produces a shirt
 * whose sleeves are four copies of the chest logo.
 */
export function buildPrompt(description, { face = 'front', category = 'shirt' } = {}) {
  const subject = String(description ?? '').trim();

  const garment =
    category === 'pants' ? 'trousers' : category === 'avatar' ? 'full body outfit' : 'shirt';

  const framing =
    face === 'front'
      ? `The main design for the front of a ${garment}.`
      : face === 'back'
        ? `A simpler companion design for the back of a ${garment}, matching the front's colours and style.`
        : `A repeating pattern in the same colours and style, for the sleeves and sides of a ${garment}. Keep it simple and even.`;

  return `${framing} Subject: ${subject}. ${ART_DIRECTION}`;
}

/**
 * What the person publishing still has to check.
 *
 * Shown beside every generated skin. A generator that implies "this passed our
 * checks so it will pass Roblox's" is worse than one that says plainly where
 * the responsibility sits - Roblox moderates on upload, and its decision is the
 * one that counts.
 */
export const PUBLISH_CHECKLIST = [
  'No brand logos, character likenesses or recognisable copyrighted art.',
  'Nothing that could read as revealing once it is on an avatar.',
  'No text - AI models produce mangled lettering, and text carries its own rules.',
  'The artwork lines up across the seams when worn.',
  'Roblox moderates every upload. This has not been reviewed by them.',
];
