/**
 * Card artwork.
 *
 * Every item in the catalogue has a preview image, and it comes from one of four places, in
 * this order of preference:
 *
 *   1. a skin's own texture, drawn as a front-facing portrait
 *   2. the pack's `pack_icon.png`, lifted out of the archive
 *   3. an image the admin uploaded
 *   4. a generated card, so nothing is ever blank
 *
 * The fourth exists because a card with no picture is worse than a plain one: the app's grid
 * collapses around it, and the item reads as broken rather than as unillustrated.
 *
 * Everything is stored as WebP at a single card size. One aspect ratio across all five kinds
 * is a deliberate simplification — a grid mixing portrait skins with landscape world
 * screenshots would either letterbox or reflow, and both look like a mistake.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../config.js';
import { rgbToHsl, rgbToHex } from '../utils/color.js';
import { readSkinPixels, inferModel, drawFrontView, averageColor } from '../utils/minecraft-skin.js';

const PREVIEWS_DIR = path.join(config.storageDir, 'previews');

export const PREVIEW_SIZE = { width: 640, height: 800 };

/** How much of the card's height the figure or icon occupies. */
const SUBJECT_SCALE = 0.8;

export async function ensurePreviewDir() {
  await fs.mkdir(PREVIEWS_DIR, { recursive: true });
}

/**
 * Draws a skin as a card, and reports what the texture turned out to be.
 *
 * The model and dimensions come back with the image because this is the only point at which
 * the texture is decoded — asking again later would mean reading the file a second time to
 * learn something already known here.
 */
export async function renderSkinCard(buffer, filename) {
  await ensurePreviewDir();

  const pixels = await readSkinPixels(buffer);
  const model = inferModel(pixels);
  const portrait = drawFrontView(pixels, model);

  const raw = { raw: { width: portrait.width, height: portrait.height, channels: 4 } };

  const figureHeight = Math.round(PREVIEW_SIZE.height * SUBJECT_SCALE);
  const figure = await sharp(portrait.data, raw)
    .resize({
      height: figureHeight,
      // Nearest-neighbour, always. A skin is pixel art at 16 pixels wide being blown up forty
      // times; any smoothing kernel turns it into a smear, and every other choice here is
      // downstream of keeping the blocks square.
      kernel: 'nearest',
      fit: 'inside',
    })
    .png()
    .toBuffer();

  const backdrop = await blurredBackdrop(portrait.data, raw);

  const output = await sharp(backdrop)
    .composite([{ input: figure, gravity: 'center' }, { input: scrim(), blend: 'over' }])
    .webp({ quality: 86 })
    .toBuffer();

  await fs.writeFile(path.join(PREVIEWS_DIR, filename), output);

  const average = averageColor(portrait);

  return {
    filename,
    bytes: output.length,
    model,
    width: pixels.width,
    height: pixels.height,
    legacy: pixels.legacy,
    color: average ? { ...rgbToHsl(average), hex: rgbToHex(average) } : null,
  };
}

/**
 * Builds a card from a pack's own icon.
 *
 * A `pack_icon.png` is usually 256×256 and often much smaller. Blowing one up to fill the card
 * would be a blurry mess, so it is floated at a readable size over a blurred copy of itself —
 * which reads as a product shot rather than as a stretched thumbnail, and costs one extra
 * sharp pass.
 */
export async function renderIconCard(iconBuffer, filename) {
  await ensurePreviewDir();

  const { output, color } = await composeOverBlur(iconBuffer, 0.62);
  await fs.writeFile(path.join(PREVIEWS_DIR, filename), output);

  return { filename, bytes: output.length, color, derived: true };
}

/**
 * Stores an image the admin uploaded.
 *
 * Cropped to fill rather than fitted, using sharp's attention strategy so the crop keeps the
 * busiest part of the picture. A world screenshot is 16:9 and the card is 4:5; fitting it
 * would put a third of the card's height into empty bars.
 */
export async function storeUploadedPreview(buffer, filename) {
  await ensurePreviewDir();

  const image = sharp(buffer, { limitInputPixels: 40_000_000 });

  let output;
  try {
    output = await image
      .resize({ ...PREVIEW_SIZE, fit: 'cover', position: 'attention' })
      .webp({ quality: 84 })
      .toBuffer();
  } catch {
    throw badImage();
  }

  await fs.writeFile(path.join(PREVIEWS_DIR, filename), output);
  return { filename, bytes: output.length, color: await colorOf(buffer) };
}

/**
 * A generated card, for an item with no artwork of any kind.
 *
 * Mostly seeds, which are a number rather than a picture, and packs whose archive carries no
 * icon. Deliberately plain: a flat field in the kind's colour with the title on it. It should
 * read as "this one has no picture yet", not as a picture.
 */
export async function renderPlaceholderCard(filename, { kind, title }) {
  await ensurePreviewDir();

  const palette = {
    skin: ['#3d7a2f', '#8fd96b'],
    addon: ['#4a2f8a', '#a06bff'],
    texture: ['#8a4a1f', '#ffa03d'],
    world: ['#1f5f70', '#2de2e6'],
    seed: ['#7a5f13', '#ffe23d'],
  }[kind] || ['#2c2c34', '#9a9aae'];

  // Escaped, because the title is admin-supplied and an ampersand in it would otherwise make
  // the SVG unparseable — which fails the upload at the very last step, after the file is
  // already stored.
  const label = escapeXml(String(title || '').slice(0, 42));
  const kindLabel = escapeXml(kind);

  const svg = `
    <svg width="${PREVIEW_SIZE.width}" height="${PREVIEW_SIZE.height}"
         xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${palette[0]}"/>
          <stop offset="100%" stop-color="#14141a"/>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#bg)"/>
      <text x="50%" y="46%" text-anchor="middle" fill="${palette[1]}"
            font-family="monospace" font-size="34" font-weight="700"
            letter-spacing="6">${kindLabel.toUpperCase()}</text>
      <text x="50%" y="54%" text-anchor="middle" fill="#ffffff" opacity="0.72"
            font-family="monospace" font-size="24">${label}</text>
    </svg>`;

  const output = await sharp(Buffer.from(svg)).webp({ quality: 88 }).toBuffer();
  await fs.writeFile(path.join(PREVIEWS_DIR, filename), output);

  return {
    filename,
    bytes: output.length,
    generated: true,
    color: await colorOf(output),
  };
}

/** Shared composition: a crisp subject floated over a blurred, darkened copy of itself. */
async function composeOverBlur(buffer, subjectFraction) {
  let metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch {
    throw badImage();
  }
  if (!metadata?.width || !metadata?.height) throw badImage();

  const backdrop = await sharp(buffer)
    .resize({ ...PREVIEW_SIZE, fit: 'cover' })
    .blur(26)
    .modulate({ brightness: 0.55, saturation: 1.2 })
    .toBuffer();

  const subject = await sharp(buffer)
    .resize({
      width: Math.round(PREVIEW_SIZE.width * subjectFraction),
      // Pack icons are pixel art as often as not, and the ones that aren't lose nothing by
      // being upscaled squarely.
      kernel: metadata.width <= 256 ? 'nearest' : 'lanczos3',
      fit: 'inside',
    })
    .png()
    .toBuffer();

  const output = await sharp(backdrop)
    .composite([{ input: subject, gravity: 'center' }, { input: scrim(), blend: 'over' }])
    .webp({ quality: 86 })
    .toBuffer();

  return { output, color: await colorOf(buffer) };
}

async function blurredBackdrop(data, raw) {
  return sharp(data, raw)
    .resize({ ...PREVIEW_SIZE, fit: 'cover' })
    .blur(30)
    .modulate({ brightness: 0.5, saturation: 1.3 })
    // The portrait has transparent margins, and a blurred transparency composited onto nothing
    // stays transparent — which shows through as a checkerboard in the panel and as whatever
    // is behind the card in the app.
    .flatten({ background: '#16161c' })
    // The output format has to be named. Given raw input and no format, sharp writes raw
    // pixels back out — bytes with no container, which the next sharp() in the chain then
    // rejects as "unsupported image format" from four lines further on.
    .png()
    .toBuffer();
}

/** A bottom-weighted scrim, so the title the app draws over the card stays legible. */
function scrim() {
  const svg = `
    <svg width="${PREVIEW_SIZE.width}" height="${PREVIEW_SIZE.height}"
         xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="#000" stop-opacity="0.12"/>
          <stop offset="55%"  stop-color="#000" stop-opacity="0.00"/>
          <stop offset="100%" stop-color="#000" stop-opacity="0.55"/>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#scrim)"/>
    </svg>`;
  return Buffer.from(svg);
}

/** The dominant colour of an image, for the catalogue's colour chips. */
async function colorOf(buffer) {
  try {
    // Alpha is flattened onto black first, so sharp's histogram is not reading undefined RGB
    // out of fully transparent pixels — which it does, and which reports the same near-black
    // for every image that has a margin.
    const flattened = await sharp(buffer).flatten({ background: { r: 0, g: 0, b: 0 } }).toBuffer();
    const { dominant } = await sharp(flattened).stats();
    return { ...rgbToHsl(dominant), hex: rgbToHex(dominant) };
  } catch {
    // A colour is a nice-to-have; never fail an upload over it.
    return null;
  }
}

function badImage() {
  return Object.assign(
    new Error("That file couldn't be read as an image. Upload a PNG, JPEG or WebP."),
    { status: 400 },
  );
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Removes a preview. A missing file is not an error — deletion should be idempotent. */
export async function removePreview(filename) {
  if (!filename) return;
  await fs.rm(path.join(PREVIEWS_DIR, filename), { force: true }).catch(() => {});
}

export async function previewUsage() {
  return measureDirectory(PREVIEWS_DIR);
}

export async function measureDirectory(dir) {
  try {
    const files = await fs.readdir(dir);
    const visible = files.filter((file) => !file.startsWith('.'));
    const sizes = await Promise.all(
      visible.map(async (file) => {
        try {
          return (await fs.stat(path.join(dir, file))).size;
        } catch {
          return 0;
        }
      }),
    );
    return { count: visible.length, bytes: sizes.reduce((a, b) => a + b, 0) };
  } catch {
    return { count: 0, bytes: 0 };
  }
}
