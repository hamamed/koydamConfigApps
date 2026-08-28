/**
 * Minecraft skin geometry.
 *
 * A skin is one texture sheet that the game wraps around a handful of boxes. Everything this
 * file does comes from knowing where each face sits on that sheet: telling a Steve skin from
 * an Alex one, and drawing the front-facing portrait the catalogue shows on a card.
 *
 * ## Coordinates
 *
 * The table below is in 64×64 texture pixels, the size Minecraft has used since 1.8. HD skins
 * are exact multiples — 128×128, 256×256 — so every coordinate is multiplied by
 * `width / 64` rather than the table being duplicated per size.
 *
 * The legacy 64×32 layout has no left arm and no left leg of its own; the game mirrors the
 * right ones. That is handled by mapping the missing parts back onto their right-hand twins
 * rather than by a second table.
 */

import sharp from 'sharp';

// ── The sheet ───────────────────────────────────────────────────────────────
//
// Each entry is [x, y, width, height] on a 64×64 sheet. `overlay` is the second layer — the
// hat, jacket and sleeves — drawn on top of the base with transparency.

const FRONT_FACES = {
  head: { base: [8, 8, 8, 8], overlay: [40, 8, 8, 8] },
  body: { base: [20, 20, 8, 12], overlay: [20, 36, 8, 12] },
  rightArm: { base: [44, 20, 4, 12], overlay: [44, 36, 4, 12] },
  leftArm: { base: [36, 52, 4, 12], overlay: [52, 52, 4, 12] },
  rightLeg: { base: [4, 20, 4, 12], overlay: [4, 36, 4, 12] },
  leftLeg: { base: [20, 52, 4, 12], overlay: [4, 52, 4, 12] },
};

/**
 * The slim model's arms are three pixels wide instead of four.
 *
 * Only the width changes; the faces start in the same place. A slim skin worn on a classic
 * body has a one-pixel seam down each arm, which is why the model is stored per item rather
 * than guessed by the app at display time.
 */
const SLIM_ARM_WIDTH = 3;

/**
 * Where the front view puts each part, in character pixels.
 *
 * The character is 16 wide and 32 tall — head 8×8 centred, body 8×12 below it, arms either
 * side, legs beneath. Those are the model's real proportions, so the portrait is the figure
 * the player will actually see rather than an arrangement that merely looks right.
 */
const LAYOUT = {
  head: { x: 4, y: 0 },
  body: { x: 4, y: 8 },
  rightArm: { x: 0, y: 8 },
  leftArm: { x: 12, y: 8 },
  rightLeg: { x: 4, y: 20 },
  leftLeg: { x: 8, y: 20 },
};

export const PORTRAIT_SIZE = { width: 16, height: 32 };

/**
 * Reads a skin PNG into raw RGBA, checking it is a skin at all.
 *
 * The dimension check is the real validation. Minecraft silently refuses a texture that is not
 * 64×64, 64×32 or an exact multiple, so accepting one here would mean publishing an item that
 * cannot be worn — and the player has no way to find out why.
 */
export async function readSkinPixels(buffer) {
  const image = sharp(buffer, { limitInputPixels: 4_000_000 });

  let metadata;
  try {
    metadata = await image.metadata();
  } catch {
    throw badSkin('That file could not be read as a PNG.');
  }

  const { width, height } = metadata;
  if (!width || !height) throw badSkin('That file could not be read as a PNG.');

  const scale = width / 64;
  const isMultiple = Number.isInteger(scale) && scale >= 1 && scale <= 8;
  const isTall = height === width;
  const isLegacy = height === width / 2;

  if (!isMultiple || !(isTall || isLegacy)) {
    throw badSkin(
      `A skin must be 64×64 (or an exact multiple, up to 512×512). That image is ${width}×${height}, `
      + 'which Minecraft will refuse.',
    );
  }

  const { data } = await image
    // A skin drawn without an alpha channel is legal and common; the overlay layer is then
    // simply opaque everywhere. Forcing four channels means the compositor below has one case.
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { data, width, height, scale, legacy: isLegacy };
}

function badSkin(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * Classic (Steve) or slim (Alex).
 *
 * Decided by looking at the parts of the sheet only a four-pixel arm uses. A slim skin leaves
 * them empty, because its arms are three wide — so if all four of those strips are fully
 * transparent, the artist drew for Alex.
 *
 * There is no flag in the file to read: Mojang stores the model against the player's account,
 * not in the texture, and every tool that handles a bare PNG infers it exactly this way.
 * A legacy 64×32 sheet predates the slim model entirely and is always classic.
 */
export function inferModel({ data, width, height, scale, legacy }) {
  if (legacy) return 'classic';

  const strips = [
    [50, 16, 2, 4],  // right arm, top face, classic-only columns
    [54, 20, 2, 12], // right arm, back face
    [42, 48, 2, 4],  // left arm, top face
    [46, 52, 2, 12], // left arm, front face
  ];

  const allTransparent = strips.every(([x, y, w, h]) =>
    isRegionTransparent(data, width, height, x * scale, y * scale, w * scale, h * scale));

  return allTransparent ? 'slim' : 'classic';
}

function isRegionTransparent(data, width, height, left, top, w, h) {
  for (let y = top; y < top + h; y += 1) {
    if (y >= height) continue;
    for (let x = left; x < left + w; x += 1) {
      if (x >= width) continue;
      if (data[(y * width + x) * 4 + 3] !== 0) return false;
    }
  }
  return true;
}

/**
 * Draws the front of the character into a raw RGBA buffer.
 *
 * Done by hand rather than as a chain of sharp composites — one per face, twelve in all — for
 * two reasons. Each composite is a full decode/encode round trip, which at twelve of them per
 * upload is most of the cost of storing a skin. And sharp cannot alpha-blend the overlay onto
 * the base at these sizes without a resize in between, which is precisely what must not happen:
 * a smooth kernel over an 8×8 face turns pixel art into mush.
 *
 * Returned at the texture's native scale. The caller resizes once, with nearest-neighbour.
 */
export function drawFrontView(pixels, model) {
  const { data, width, height, scale, legacy } = pixels;

  const canvasWidth = PORTRAIT_SIZE.width * scale;
  const canvasHeight = PORTRAIT_SIZE.height * scale;
  const canvas = Buffer.alloc(canvasWidth * canvasHeight * 4, 0);

  const armWidth = model === 'slim' ? SLIM_ARM_WIDTH : 4;

  for (const [part, position] of Object.entries(LAYOUT)) {
    const faces = FRONT_FACES[part];

    // Legacy sheets carry only the right limbs. The game mirrors them onto the left, so the
    // portrait does too — otherwise half the character is missing rather than merely simpler.
    const source = legacy && (part === 'leftArm' || part === 'leftLeg')
      ? FRONT_FACES[part === 'leftArm' ? 'rightArm' : 'rightLeg']
      : faces;

    const isArm = part === 'rightArm' || part === 'leftArm';
    const faceWidth = isArm ? armWidth : source.base[2];

    // A slim left arm sits one pixel further in, so the gap stays on the outside of the
    // figure where a thinner arm actually is, rather than opening up between arm and body.
    const offsetX = isArm && part === 'leftArm' ? position.x + (4 - armWidth) : position.x;

    blit(canvas, canvasWidth, data, width, height, {
      sx: source.base[0] * scale,
      sy: source.base[1] * scale,
      sw: faceWidth * scale,
      sh: source.base[3] * scale,
      dx: offsetX * scale,
      dy: position.y * scale,
      // The left arm and leg of a legacy skin are the right ones seen from the front, so they
      // are drawn mirrored. Not doing this puts the character's seams on the wrong side.
      mirror: legacy && (part === 'leftArm' || part === 'leftLeg'),
    });

    // The second layer. Absent on legacy sheets except for the hat, and the loop below simply
    // finds nothing to draw in that case, since those pixels are transparent.
    if (!legacy || part === 'head') {
      blit(canvas, canvasWidth, data, width, height, {
        sx: source.overlay[0] * scale,
        sy: source.overlay[1] * scale,
        sw: faceWidth * scale,
        sh: source.overlay[3] * scale,
        dx: offsetX * scale,
        dy: position.y * scale,
        mirror: false,
      });
    }
  }

  return { data: canvas, width: canvasWidth, height: canvasHeight };
}

/**
 * Copies one rectangle onto another, blending on alpha.
 *
 * Source-over compositing, done in straight (non-premultiplied) alpha because that is how the
 * pixels arrive from sharp and how they must leave. Fully opaque source pixels — the
 * overwhelming majority — take the fast path.
 */
function blit(dest, destWidth, src, srcWidth, srcHeight, { sx, sy, sw, sh, dx, dy, mirror }) {
  for (let y = 0; y < sh; y += 1) {
    const sourceY = sy + y;
    if (sourceY >= srcHeight) continue;

    for (let x = 0; x < sw; x += 1) {
      const sourceX = mirror ? sx + (sw - 1 - x) : sx + x;
      if (sourceX >= srcWidth) continue;

      const s = (sourceY * srcWidth + sourceX) * 4;
      const alpha = src[s + 3];
      if (alpha === 0) continue;

      const d = ((dy + y) * destWidth + (dx + x)) * 4;

      if (alpha === 255) {
        dest[d] = src[s];
        dest[d + 1] = src[s + 1];
        dest[d + 2] = src[s + 2];
        dest[d + 3] = 255;
        continue;
      }

      const sourceAlpha = alpha / 255;
      const destAlpha = dest[d + 3] / 255;
      const outAlpha = sourceAlpha + destAlpha * (1 - sourceAlpha);

      if (outAlpha === 0) continue;

      for (let channel = 0; channel < 3; channel += 1) {
        dest[d + channel] = Math.round(
          (src[s + channel] * sourceAlpha + dest[d + channel] * destAlpha * (1 - sourceAlpha))
          / outAlpha,
        );
      }
      dest[d + 3] = Math.round(outAlpha * 255);
    }
  }
}

/**
 * The average colour of the character's opaque pixels.
 *
 * Measured on the drawn figure rather than on the sheet, because a sheet is largely empty
 * space and the unused regions of a slim skin are transparent black — averaging those in
 * pulls every skin toward the same murky grey and makes the colour filter useless.
 */
export function averageColor({ data, width, height }) {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    // Half-transparent pixels are edges and shadows; including them drags the average toward
    // whatever is behind the figure, which is nothing.
    if (data[offset + 3] < 128) continue;
    r += data[offset];
    g += data[offset + 1];
    b += data[offset + 2];
    count += 1;
  }

  if (count === 0) return null;
  return { r: r / count, g: g / count, b: b / count };
}
