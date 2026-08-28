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
export function buildPrompt(
  description,
  { face = 'front', category = 'shirt', direction = null } = {},
) {
  // A planned direction replaces the subject, never the framing or the art
  // rules. Those exist because their absence produced unusable art, and a
  // planner that could drop them would be a planner that can quietly undo
  // every lesson encoded above.
  const subject = String(direction || description || '').trim();

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


/**
 * The planner's brief.
 *
 * It writes in words first, for two reasons. A person can read a sentence and
 * say "not orange" before any money is spent, which is not true of an image.
 * And the model that is good at deciding what a design should be is not the
 * one that draws it — asking the image model to plan and execute in one step
 * means the plan only ever exists as pixels, where it cannot be corrected.
 *
 * It is told the same content rules the blocklist enforces, so it declines at
 * the point where a person is still in the conversation rather than producing
 * a plan that `checkPrompt` will reject a moment later.
 */
const PLANNER_BASE = [
  'You are an art director for Roblox classic clothing templates.',
  'Given a description, plan the artwork. Be concrete: palette, motifs, mood,',
  'and what differs between the front, the back and the side pattern.',
  '',
  'Rules you must respect, because Roblox moderates every upload:',
  'no brand logos, no real people or characters, no gore, nothing revealing,',
  'no drug or weapon imagery, and no text or lettering of any kind.',
  'If the request breaks one of these, say so plainly and stop.',
  '',
  'Write 2 to 4 short sentences of plain English first — this is read by a',
  'person deciding whether to spend money generating it, so no preamble and',
  'no restating the request back.',
  '',
  'Then output a line containing only ---',
  'Then a JSON object, and nothing after it.',
].join('\n');

/**
 * The planner's brief, for the style being planned.
 *
 * The two modes want opposite things from the same model. Pattern mode needs
 * artwork and must be told not to describe clothing, because a prompt that
 * mentions a shirt produces a picture of a shirt printed onto a shirt. Garment
 * mode needs clothing described panel by panel, because each panel is drawn
 * separately and lands somewhere specific.
 *
 * One brief trying to cover both would have to contradict itself.
 */
export function plannerSystem({ style = 'pattern', category = 'shirt' } = {}) {
  if (style !== 'garment') {
    return [
      PLANNER_BASE,
      'The object has the form:',
      '{"front": "...", "back": "...", "pattern": "..."}',
      'Each value describes the ARTWORK for that face in one sentence: subject,',
      'colours, composition. Never describe a garment, a body, or a person —',
      'these become texture prompts, and a prompt that mentions a shirt produces',
      'a picture of a shirt printed onto a shirt.',
    ].join('\n');
  }

  const regions = regionsFor(category);

  return [
    PLANNER_BASE,
    `The object has exactly these keys: ${regions.map((r) => `"${r}"`).join(', ')}.`,
    'Each value describes that PANEL of the garment in one sentence: cut,',
    'fabric, colour, and the details that belong on it — a collar and placket on',
    'the chest, a cuff on the sleeve, a waistband on the waist.',
    'Describe real clothing. Say what it is made of and how it is finished.',
    'Keep the fabric and colours identical across every panel: they are one',
    'garment seen in pieces, not several garments.',
  ].join('\n');
}

/** Kept for the pattern default, so existing callers read the same as before. */
export const PLANNER_SYSTEM = plannerSystem({ style: 'pattern' });

/**
 * Splits the planner's answer into the part a person reads and the part the
 * image model is given.
 *
 * Tolerant on purpose. A plan whose JSON is malformed is still a plan worth
 * showing, and the caller falls back to the built prompts — losing the
 * planner's wording is a worse result than a plain generation, but it is a far
 * better one than an error where a design used to be.
 */
export function parsePlan(text, keys = ['front', 'back', 'pattern']) {
  const raw = String(text ?? '');
  const separator = raw.indexOf('\n---');

  const reasoning = (separator === -1 ? raw : raw.slice(0, separator)).trim();
  if (separator === -1) return { reasoning, directions: null };

  // The model sometimes wraps the JSON in a code fence despite being asked not
  // to. Taking the outermost braces is what survives that without a parser.
  const tail = raw.slice(separator + 4);
  const start = tail.indexOf('{');
  const end = tail.lastIndexOf('}');
  if (start === -1 || end <= start) return { reasoning, directions: null };

  try {
    const parsed = JSON.parse(tail.slice(start, end + 1));
    const directions = {};
    for (const key of keys) {
      if (typeof parsed[key] === 'string' && parsed[key].trim()) {
        directions[key] = parsed[key].trim();
      }
    }
    return { reasoning, directions: Object.keys(directions).length ? directions : null };
  } catch {
    return { reasoning, directions: null };
  }
}


/**
 * The brief for suggesting ideas.
 *
 * A blank textarea is the hardest part of this screen. Someone who knows they
 * want "something for autumn" still has to turn that into a sentence an image
 * model can draw, and the gap between those two things is where people give up
 * or type the thing that produces a picture of a shirt.
 *
 * Ideas are cheap — text tokens, no images — so this is the one place to be
 * generous with options.
 */
export const IDEAS_SYSTEM = [
  'You suggest artwork ideas for Roblox classic clothing.',
  '',
  'Rules, because Roblox moderates every upload: no brand logos, no real',
  'people or characters, no gore, nothing revealing, no drug or weapon',
  'imagery, and no text or lettering.',
  '',
  'Each idea describes ARTWORK — a pattern, a scene, a texture. Never a',
  'garment, a body or a person: these become texture prompts, and one that',
  'mentions a shirt produces a picture of a shirt printed onto a shirt.',
  '',
  'Make them genuinely different from each other — different palettes, moods',
  'and subjects. Six variations on one idea is one idea.',
  '',
  'Reply with a JSON array and nothing else:',
  '[{"name": "Short name", "description": "One sentence of artwork detail."}]',
].join('\n');

/**
 * Pulls the ideas out of the model's reply.
 *
 * Tolerant in the same way `parsePlan` is: a code fence or a sentence of
 * preamble is common, and losing every idea to one stray character would be a
 * worse outcome than showing the ones that parsed.
 */
export function parseIdeas(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end <= start) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((idea) => idea && typeof idea.description === 'string' && idea.description.trim())
    .map((idea) => ({
      name: String(idea.name ?? '').trim().slice(0, 60) || 'Idea',
      description: idea.description.trim().slice(0, 300),
    }))
    // An idea that breaks the content rules is not shown at all: offering it
    // and refusing it a moment later wastes the one thing this step saves.
    .filter((idea) => checkPrompt(idea.description).ok)
    .slice(0, 8);
}


/**
 * Drawing actual clothes instead of a pattern.
 *
 * ## Why this needed a second set of rules
 *
 * ART_DIRECTION forbids collars, cuffs and seams, and that was right for what
 * it does: one square is stretched onto every `front` face, so a collar drawn
 * on the chest lands on both sleeves as well. Forbidding garment features was
 * the only way to stop the artwork contradicting the geometry.
 *
 * Garment mode removes the cause instead. Artwork is generated per region —
 * chest, back, sleeve — so a collar can be asked for on the panel that becomes
 * a chest and nowhere else.
 *
 * ## Why the framing talks about edges
 *
 * Each region maps to a known rectangle on a known part of the body, so where
 * a feature belongs can be stated in terms the model can act on: a collar
 * across the TOP edge of the chest panel really does end up at the neck, and a
 * cuff across the BOTTOM edge of a sleeve panel really does end up at the
 * wrist. Composition scales each panel to fill its rectangle, so an edge in the
 * artwork is an edge on the avatar.
 */
const GARMENT_DIRECTION = [
  'Draw the flat fabric panel itself, straight on, filling the square edge to edge.',
  'No body, no mannequin, no person, no hanger, and no photograph of a folded garment.',
  'No perspective, no 3D render, no drop shadow, no background behind it —',
  'the panel IS the whole square.',
  'Fabric detail is wanted: weave, knit, ribbing, stitching, seams, buttons where asked for.',
  'Shading only as the fabric would fold, never as scene lighting.',
  'No text, letters, numbers, logos or brand marks.',
  'Keep the colours and material identical across every panel of the same garment.',
].join(' ');

/**
 * The regions each garment is drawn in.
 *
 * Three for the everyday cases, because each one is a paid image and a shirt
 * is legible from a chest, a back and a sleeve. A full-body sheet needs a leg
 * as well — its limb groups paint arms and legs from the same rectangles, so
 * without one the trousers would be made of sleeve.
 */
export const GARMENT_REGIONS = {
  shirt: ['chest', 'back', 'sleeve'],
  tshirt: ['chest', 'back', 'sleeve'],
  pants: ['waist', 'legFront', 'legBack'],
  // Three, not four. A sheet carries two limb groups and a full-body texture
  // paints the arm and the leg on each side from the same rectangles — so a
  // separate trouser-leg panel would be paid for and then overwritten by
  // whichever of the two was composed last.
  avatar: ['chest', 'back', 'limb'],
};

export function regionsFor(category) {
  return GARMENT_REGIONS[category] ?? GARMENT_REGIONS.shirt;
}

/** What each region becomes on the avatar, said in edges the model can act on. */
const REGION_FRAMING = {
  chest:
    'The FRONT panel of the garment, from shoulders to hem. The collar or '
    + 'neckline sits across the TOP edge. Any button placket, zip or print runs '
    + 'down the CENTRE. The hem is along the BOTTOM edge.',
  back:
    'The BACK panel of the same garment. A yoke or collar band across the TOP '
    + 'edge, hem along the BOTTOM. Plainer than the front — the same fabric and '
    + 'colours, without the placket or the main graphic.',
  sleeve:
    'ONE SLEEVE of the same garment, laid flat. The shoulder seam is along the '
    + 'TOP edge and the cuff is a band across the BOTTOM edge. No collar, no '
    + 'buttons down it, no chest graphic — this is the arm.',
  waist:
    'The waist and hips of the trousers. The waistband runs across the TOP '
    + 'edge, with belt loops on it, and the fly runs down the CENTRE. The fabric '
    + 'continues past the BOTTOM edge into the legs.',
  legFront:
    'The FRONT of one trouser leg. The fabric continues past the TOP edge from '
    + 'the hip, and the hem is a band across the BOTTOM edge. Include the '
    + 'creases and pockets the trousers would have.',
  legBack:
    'The BACK of the same trouser leg. Same fabric and colour, plainer, hem '
    + 'across the BOTTOM edge.',
  leg:
    'One trouser leg of the outfit, laid flat. The fabric continues past the '
    + 'TOP edge and the hem is a band across the BOTTOM edge.',
  limb:
    'ONE LIMB of the outfit, laid flat. On a full-body sheet this same panel '
    + 'becomes both the sleeve and the trouser leg, so keep it plain and '
    + 'continuous: the fabric runs past the TOP edge, and the BOTTOM edge is a '
    + 'simple band that reads as either a cuff or a hem. No collar, no buttons, '
    + 'no pockets, no chest graphic.',
};

/**
 * A prompt for one region of a real garment.
 *
 * The region's framing comes first so it is the thing the model is least
 * likely to drop, then what the person asked for, then the rules.
 */
export function buildGarmentPrompt(
  description,
  { region = 'chest', category = 'shirt', direction = null } = {},
) {
  const framing = REGION_FRAMING[region] ?? REGION_FRAMING.chest;
  const garment = category === 'pants' ? 'trousers'
    : category === 'avatar' ? 'a full outfit'
    : category === 'tshirt' ? 'a t-shirt'
    : 'a shirt';

  const subject = String(direction || description || '').trim();

  return `A flat clothing texture panel for ${garment}. ${framing} `
    + `The garment: ${subject}. ${GARMENT_DIRECTION}`;
}
