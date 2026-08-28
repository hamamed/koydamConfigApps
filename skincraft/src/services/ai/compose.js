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
 * Removes a flat border the model added despite being told not to.
 *
 * Asking for a surface rather than an object stops most of it, but not all: a
 * sleeve is a narrow thing, and a model drawing one will sometimes still centre
 * it on a background. Composition then scales that border onto the avatar,
 * where it reads as a white seam down the arm.
 *
 * The guard matters more than the trim. `trim` works from the corner pixel, so
 * a genuinely plain panel — a white dress shirt, a black sweater — is a border
 * all the way through and would collapse to almost nothing. When that happens
 * the original is kept: a panel that is meant to be one colour is not a panel
 * with a margin, and there is no way to tell them apart except by how much is
 * left.
 */
async function trimFlatBorder(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) return buffer;

    // Measured on a small copy. A margin is a large-scale feature, and scanning
    // a thumbnail is hundreds of times cheaper than scanning the panel.
    const w = 96;
    const h = Math.max(16, Math.round((meta.height / meta.width) * w));
    const { data } = await sharp(buffer)
      .resize(w, h, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const at = (x, y) => { const i = (y * w + x) * 3; return [data[i], data[i + 1], data[i + 2]]; };
    const gap = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    const near = (a, b) => gap(a, b) < 34;

    const frame = at(0, 0);

    const line = (pts) => pts.every((p) => near(at(p[0], p[1]), frame));
    const across = (n) => [...Array(n).keys()];

    const topFlat = line(across(w).map((x) => [x, 0]));
    const bottomFlat = line(across(w).map((x) => [x, h - 1]));
    const leftFlat = line(across(h).map((y) => [0, y]));
    const rightFlat = line(across(h).map((y) => [w - 1, y]));

    // The centre has to be something else, or this is a plain panel and the
    // "frame" is the garment.
    if (near(at(w >> 1, h >> 1), frame)) return buffer;

    // Which edges may be cut, and why they are not treated alike.
    //
    // The top and bottom of a panel are where the garment's own bands live: a
    // collar, a yoke, a cuff, a hem. A flat strip there is design as often as
    // it is background, and cutting a collar off is worse than leaving a
    // border on — so those only come off when all four edges agree, which is a
    // frame and cannot be a collar.
    //
    // The far left and right are not like that. The panel wraps around a limb
    // or a torso, so those edges are a seam with the next panel; a flat band at
    // both of them is the model centring a garment on a background, which is
    // exactly what it does when asked for a shirt front. Nothing a garment has
    // looks like that.
    const framed = topFlat && bottomFlat && leftFlat && rightFlat;
    const sidesOnly = leftFlat && rightFlat;

    if (!framed && !sidesOnly) return buffer;

    const limitX = Math.floor(w * 0.42);
    const limitY = Math.floor(h * 0.42);

    let left = 0; while (left < limitX && line(across(h).map((y) => [left, y]))) left++;
    let right = 0; while (right < limitX && line(across(h).map((y) => [w - 1 - right, y]))) right++;

    let top = 0;
    let bottom = 0;
    if (framed) {
      while (top < limitY && line(across(w).map((x) => [x, top]))) top++;
      while (bottom < limitY && line(across(w).map((x) => [x, h - 1 - bottom]))) bottom++;
    }

    if (left + right + top + bottom === 0) return buffer;

    // Back to full resolution, a hair inside the boundary so a soft edge does
    // not survive as a pale line along the seam.
    const bleed = 1;
    const sx = Math.round(((left + bleed) / w) * meta.width);
    const sy = Math.round(((top + bleed) / h) * meta.height);
    const sw = meta.width - sx - Math.round(((right + bleed) / w) * meta.width);
    const sh = meta.height - sy - Math.round(((bottom + bleed) / h) * meta.height);

    if (sw < meta.width * 0.15 || sh < meta.height * 0.15) return buffer;

    return sharp(buffer).extract({ left: sx, top: sy, width: sw, height: sh }).png().toBuffer();
  } catch {
    // A panel that cannot be trimmed keeps its border, which is where this
    // started from.
    return buffer;
  }
}

/**
 * Public because the pipeline trims each panel once as it arrives, rather than
 * once per face — the same sleeve is composed onto six of them.
 */
export async function tidyPanel(buffer) {
  return trimFlatBorder(buffer);
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
