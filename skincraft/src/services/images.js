import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../config.js';
import { TEMPLATE_SIZE } from '../utils/validate.js';
import { heroRegion } from '../utils/template-layout.js';
import { rgbToHsl, rgbToHex } from '../utils/color.js';

const TEMPLATES_DIR = path.join(config.storageDir, 'templates');
const PREVIEWS_DIR = path.join(config.storageDir, 'previews');

const PREVIEW_SIZE = { width: 640, height: 800 };

export async function ensureStorageDirs() {
  await fs.mkdir(TEMPLATES_DIR, { recursive: true });
  await fs.mkdir(PREVIEWS_DIR, { recursive: true });
}

/**
 * Normalises an uploaded template to PNG and writes it to storage.
 *
 * The re-encode is deliberate. It strips EXIF and any other metadata a creator's editor left
 * behind, guarantees the bytes really are an image (sharp throws otherwise) rather than
 * something renamed to `.png`, and gives every asset a consistent colour profile.
 */
export async function storeTemplate(buffer, filename) {
  await ensureStorageDirs();

  const { metadata, output } = await decode(buffer, (image) =>
    image.png({ compressionLevel: 9, palette: false }).toBuffer()
  );

  await fs.writeFile(path.join(TEMPLATES_DIR, filename), output);

  return {
    filename,
    width: metadata.width,
    height: metadata.height,
    bytes: output.length,
  };
}

/**
 * Runs a sharp pipeline and turns any decode failure into a 400 the admin can act on.
 *
 * sharp throws a low-level libvips message for anything that isn't really an image — a renamed
 * `.txt`, a truncated download, an SVG bomb. Left alone that surfaces as a 500 and reads like
 * the server broke, when in fact the upload was simply not a picture.
 */
async function decode(buffer, transform) {
  const image = sharp(buffer, { limitInputPixels: 40_000_000 });

  let metadata;
  try {
    metadata = await image.metadata();
  } catch {
    throw badImage();
  }

  if (!metadata?.width || !metadata?.height) throw badImage();

  try {
    return { metadata, output: await transform(image) };
  } catch {
    throw badImage();
  }
}

function badImage() {
  return Object.assign(
    new Error("That file couldn't be read as an image. Upload a PNG, JPEG or WebP."),
    { status: 400 }
  );
}

/** Stores a creator-supplied preview image, converted to WebP at card dimensions. */
export async function storePreview(buffer, filename) {
  await ensureStorageDirs();

  const { output } = await decode(buffer, (image) =>
    image
      .resize({ ...PREVIEW_SIZE, fit: 'cover', position: 'attention' })
      .webp({ quality: 82 })
      .toBuffer()
  );

  await fs.writeFile(path.join(PREVIEWS_DIR, filename), output);
  return { filename, bytes: output.length };
}

/**
 * Builds a card preview from the template itself, for when no artwork is supplied.
 *
 * The composition is a blurred, darkened blow-up of the garment's front face as a backdrop with
 * a crisp, nearest-neighbour upscale of the same region floated on top. That reads as a product
 * shot rather than as a stretched thumbnail, and it costs one extra sharp pass per upload.
 */
export async function derivePreview(buffer, filename, category) {
  await ensureStorageDirs();

  // Decode once up front so an unreadable file fails as a 400 here rather than mid-composite.
  const { metadata } = await decode(buffer, (image) => image.toBuffer());

  const region = regionFor(category, metadata.width, metadata.height);
  const heroBuffer = await sharp(buffer).extract(region).png().toBuffer();

  const backdrop = await sharp(heroBuffer)
    .resize({ ...PREVIEW_SIZE, fit: 'cover' })
    .blur(28)
    .modulate({ brightness: 0.55, saturation: 1.25 })
    .toBuffer();

  const heroWidth = Math.round(PREVIEW_SIZE.width * 0.62);
  const hero = await sharp(heroBuffer)
    .resize({
      width: heroWidth,
      // `nearest` preserves the blocky pixel edges Roblox templates are drawn with; a smooth
      // kernel turns pixel art into mush at this scale factor.
      kernel: 'nearest',
      fit: 'inside',
    })
    .toBuffer();

  const output = await sharp(backdrop)
    .composite([{ input: hero, gravity: 'center' }, { input: vignette(), blend: 'over' }])
    .webp({ quality: 84 })
    .toBuffer();

  await fs.writeFile(path.join(PREVIEWS_DIR, filename), output);
  return { filename, bytes: output.length, derived: true };
}

/**
 * Samples the garment's dominant colour, for the catalogue's colour filter.
 *
 * Measured on the *hero region* rather than the whole sheet, because a template is mostly
 * transparent padding — averaging that in pulls every skin toward the same washed-out grey.
 * Alpha is flattened onto black first so sharp's histogram isn't reading undefined RGB values
 * out of fully transparent pixels.
 */
export async function dominantColor(buffer, category) {
  try {
    const image = sharp(buffer, { limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();
    const region = regionFor(category, metadata.width, metadata.height);

    // `stats()` reads the *input* image and ignores pipeline operations, so the crop has to be
    // materialised into its own buffer first — otherwise every skin reports the colour of the
    // whole mostly-transparent sheet, which is the same near-black for all of them.
    const cropped = await sharp(buffer)
      .extract(region)
      .flatten({ background: { r: 0, g: 0, b: 0 } })
      .toBuffer();

    const { dominant } = await sharp(cropped).stats();

    const { hue, saturation, lightness } = rgbToHsl(dominant);
    return {
      hue,
      saturation,
      lightness,
      hex: rgbToHex(dominant),
    };
  } catch {
    // A colour is a nice-to-have; never fail an upload over it.
    return null;
  }
}

/** A bottom-weighted scrim so the title the app draws over the card stays legible. */
function vignette() {
  const svg = `
    <svg width="${PREVIEW_SIZE.width}" height="${PREVIEW_SIZE.height}"
         xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"  stop-color="#000" stop-opacity="0.10"/>
          <stop offset="55%" stop-color="#000" stop-opacity="0.00"/>
          <stop offset="100%" stop-color="#000" stop-opacity="0.55"/>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#scrim)"/>
    </svg>`;
  return Buffer.from(svg);
}

/** Clamps the hero crop to the actual image, falling back to a centre crop for odd sizes. */
function regionFor(category, width, height) {
  // Coordinates come from the shared layout, which the seeder and the browser designer also read.
  const region = heroRegion(category);

  // Only trust the coordinates when the upload really is template-shaped; on anything else they
  // would crop an arbitrary rectangle out of unrelated artwork.
  const fitsTemplate =
    region && width >= TEMPLATE_SIZE.width * 0.9 && height >= TEMPLATE_SIZE.height * 0.9;

  if (!fitsTemplate) {
    const side = Math.floor(Math.min(width, height) * 0.8);
    return {
      left: Math.floor((width - side) / 2),
      top: Math.floor((height - side) / 2),
      width: side,
      height: side,
    };
  }

  return {
    left: Math.min(region.left, width - region.width),
    top: Math.min(region.top, height - region.height),
    width: Math.min(region.width, width),
    height: Math.min(region.height, height),
  };
}

/** Removes a skin's files. Missing files are not an error — deletion should be idempotent. */
export async function removeAssets({ templateFile, previewFile }) {
  const targets = [
    templateFile && path.join(TEMPLATES_DIR, templateFile),
    previewFile && path.join(PREVIEWS_DIR, previewFile),
  ].filter(Boolean);

  await Promise.all(
    targets.map((target) => fs.rm(target, { force: true }).catch(() => {}))
  );
}

export async function storageUsage() {
  const measure = async (dir) => {
    try {
      const files = await fs.readdir(dir);
      const sizes = await Promise.all(
        files.map(async (file) => {
          try {
            return (await fs.stat(path.join(dir, file))).size;
          } catch {
            return 0;
          }
        })
      );
      return { count: files.filter((f) => !f.startsWith('.')).length, bytes: sizes.reduce((a, b) => a + b, 0) };
    } catch {
      return { count: 0, bytes: 0 };
    }
  };

  const [templates, previews] = await Promise.all([measure(TEMPLATES_DIR), measure(PREVIEWS_DIR)]);
  return {
    templates,
    previews,
    totalBytes: templates.bytes + previews.bytes,
  };
}
