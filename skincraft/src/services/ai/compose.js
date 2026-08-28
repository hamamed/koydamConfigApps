import sharp from 'sharp';

import {
  FACE_SHADE,
  LAYOUTS,
  TEMPLATE_SIZE,
} from '../../utils/template-layout.js';

/**
 * Turns generated artwork into a Roblox clothing template.
 *
 * ## Why the model does not draw the template
 *
 * An image model has no idea what a Roblox UV unwrap is. Ask one for a 585x559
 * clothing template and it produces something that looks vaguely like the
 * reference sheets in its training data - the right general appearance, with
 * every rectangle in the wrong place. Worn, the chest design lands on a sleeve
 * and the seams do not meet.
 *
 * So the model draws flat artwork, and this places it. The geometry comes from
 * template-layout.js, measured from Roblox's own files and verified on a 3D
 * rig, which means the result is correct by construction rather than by luck.
 *
 * ## Why faces are shaded
 *
 * A garment painted one flat image on every face reads as a decal wrapped
 * round a box. Roblox does not light clothing textures, so the shading that
 * makes fabric look like fabric has to be painted in - which is what
 * FACE_SHADE is for, and why the same artwork on the back looks like the back
 * rather than a second front.
 */

/** Every face gets artwork; this decides which of the generated pieces it uses. */
function patternSource(face, art) {
  if (face === 'front') return art.front;
  if (face === 'back') return art.back ?? art.front;
  // Sides, top and bottom: the pattern if one was generated, else the front
  // artwork. A sleeve showing the chest design is worse than a sleeve showing
  // a plain continuation, but it is better than a hole.
  return art.pattern ?? art.back ?? art.front;
}

/**
 * Which panel of a real garment belongs on this face of this body part.
 *
 * This is the whole difference between garment mode and pattern mode. Pattern
 * mode keys artwork by face, so the one `front` image lands on the chest and on
 * both sleeve fronts — which is why the pattern rules forbid collars, and why a
 * shirt drawn that way cannot have one. Keying by part as well means the chest
 * panel goes only where a chest is.
 *
 * The vertical crop is what makes the edges hold. A tall face (64x128) covered
 * from a square keeps its full height and loses width, so a cuff painted across
 * the bottom of a sleeve panel arrives at the wrist rather than being cropped
 * away.
 *
 * Every branch falls back rather than returning nothing: a missing panel should
 * cost detail, never leave a hole for the avatar's skin to show through.
 */
function garmentSource(part, face, art) {
  const anyTorso = art.chest ?? art.back ?? art.waist;

  // A full-body sheet paints the arm and the leg on each side from one limb
  // group, so both ask for the same panel — anything else pays for artwork that
  // is composed and then immediately overwritten.
  if (part === 'rightArm' || part === 'leftArm') {
    return art.limb ?? art.sleeve ?? anyTorso;
  }

  if (part === 'rightLeg' || part === 'leftLeg') {
    if (art.limb) return art.limb;
    if (face === 'front') return art.legFront ?? art.leg ?? art.sleeve ?? anyTorso;
    return art.legBack ?? art.leg ?? art.legFront ?? art.sleeve ?? anyTorso;
  }

  // The torso group. On trousers this is the waist and hips, and it has one
  // panel rather than a front and a back.
  if (art.waist) return art.waist;

  if (face === 'front') return art.chest ?? art.back;
  if (face === 'back') return art.back ?? art.chest;
  // Sides, shoulders and the underside of the hem: plain fabric reads better
  // here than a second copy of the chest or the back. The sleeve is that panel
  // on a shirt, and the limb is on a full-body sheet.
  return art.sleeve ?? art.limb ?? art.back ?? art.chest;
}

/**
 * Scales artwork to a rectangle and shades it.
 *
 * `cover` rather than `contain`: a face must be filled edge to edge. Letterbox
 * bars would appear on the avatar as stripes of blank fabric along the seams.
 */
async function faceTile(source, rect, shade) {
  const pipeline = sharp(source)
    .resize(rect.width, rect.height, { fit: 'cover', position: 'centre' });

  if (shade !== 1) {
    // Multiplying the channels rather than compositing a black overlay: an
    // overlay flattens the artwork toward grey, while this keeps the hue and
    // only moves the brightness, which is what a lit surface does.
    pipeline.linear(shade, 0);
  }

  return pipeline.png().toBuffer();
}

/**
 * Builds the finished 585x559 sheet.
 *
 * `art` carries at least `front`; `back` and `pattern` are optional buffers.
 * Anything not painted stays transparent, which is how Roblox reads "leave the
 * avatar's own skin showing here".
 */
export async function composeTemplate(art, category = 'shirt', style = 'pattern') {
  const garment = style === 'garment';

  if (!garment && !art?.front) throw new Error('No artwork to compose');
  if (garment && !(art?.chest || art?.waist || art?.legFront || art?.sleeve)) {
    throw new Error('No artwork to compose');
  }

  const layout = LAYOUTS[category] ?? LAYOUTS.shirt;

  const composites = [];

  for (const [part, group] of Object.entries(layout)) {
    for (const [face, rect] of Object.entries(group)) {
      const source = garment
        ? garmentSource(part, face, art)
        : patternSource(face, art);
      const shade = FACE_SHADE[face] ?? 1;

      composites.push({
        input: await faceTile(source, rect, shade),
        left: rect.left,
        top: rect.top,
      });
    }
  }

  return sharp({
    create: {
      width: TEMPLATE_SIZE.width,
      height: TEMPLATE_SIZE.height,
      channels: 4,
      // Transparent, not white. A white sheet paints the avatar's unclothed
      // areas white instead of leaving them bare.
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

/**
 * A flat colour swatch, for testing the pipeline without paying a provider.
 *
 * Used by the region check below and by the tests, so the geometry can be
 * verified without an API key or a network.
 */
export async function swatch(hex = '#4f46e5', size = 512) {
  const { r, g, b } = hexToRgb(hex);
  return sharp({
    create: { width: size, height: size, channels: 4, background: { r, g, b, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

function hexToRgb(hex) {
  const clean = String(hex).replace('#', '');
  const n = Number.parseInt(clean.length === 3
    ? clean.split('').map((c) => c + c).join('')
    : clean, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * Renders the layout with each face in its own colour.
 *
 * Not decoration: it is how someone confirms the geometry is right without
 * uploading to Roblox and dressing an avatar. If a face lands in the wrong
 * rectangle, a labelled render shows it immediately, while a finished skin
 * hides it until somebody wears the thing.
 */
export async function layoutProof(category = 'shirt') {
  const layout = LAYOUTS[category] ?? LAYOUTS.shirt;

  const colours = {
    front: '#ef4444',
    back: '#3b82f6',
    left: '#22c55e',
    right: '#eab308',
    top: '#a855f7',
    bottom: '#f97316',
  };

  const composites = [];

  for (const group of Object.values(layout)) {
    for (const [face, rect] of Object.entries(group)) {
      const tile = await swatch(colours[face] ?? '#888888', 64);
      composites.push({
        input: await sharp(tile).resize(rect.width, rect.height, { fit: 'fill' }).png().toBuffer(),
        left: rect.left,
        top: rect.top,
      });
    }
  }

  return sharp({
    create: {
      width: TEMPLATE_SIZE.width,
      height: TEMPLATE_SIZE.height,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();
}
