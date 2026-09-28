/**
 * Scheduled posts draw their images on the server with the very function the
 * panel's «منشور اليوم» page uses in the browser (public/js/post-draw.js), on a
 * Skia canvas with the game's own fonts. JPEG, because Instagram takes nothing
 * else.
 */
import fs from 'node:fs';
import path from 'node:path';

import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';

import { config } from './config.js';
import { drawPost } from '../public/js/post-draw.js';

export const SIZES = { square: [1080, 1080], story: [1080, 1920] };
const JPEG_QUALITY = 92;
/** Apple's badge is drawn from its SVG at this many times its own size, so it stays sharp. */
const BADGE_SCALE = 10;

const fontsDir = path.join(config.root, 'assets', 'fonts');
let fontsReady = false;
function registerFonts() {
  if (fontsReady) return;
  for (const file of ['Tajawal-Medium.ttf', 'Tajawal-Bold.ttf', 'Tajawal-ExtraBold.ttf']) {
    GlobalFonts.registerFromPath(path.join(fontsDir, file), 'Tajawal');
  }
  GlobalFonts.registerFromPath(path.join(fontsDir, 'Lalezar-Regular.ttf'), 'Lalezar');
  fontsReady = true;
}

const siteFile = (name) => path.join(config.root, 'public', 'site', name);

async function loadBadge() {
  const svg = fs.readFileSync(siteFile('badge-app-store.svg'), 'utf8')
    .replace(/width="([\d.]+)"/, (_m, w) => `width="${Number(w) * BADGE_SCALE}"`)
    .replace(/height="([\d.]+)"/, (_m, h) => `height="${Number(h) * BADGE_SCALE}"`);
  return loadImage(Buffer.from(svg));
}

/**
 * The post's image as a JPEG buffer. `post` is what the panel page draws
 * (`postFor` in post-content.js); `picturePath` is the question's picture on disk.
 */
export async function renderPost(post, kind, { picturePath = null, showCredit = true } = {}) {
  const size = SIZES[kind];
  if (!size) throw new Error(`Unknown post size: ${kind}`);
  registerFonts();
  const [icon, picture, badge] = await Promise.all([
    loadImage(fs.readFileSync(siteFile('app-icon.png'))),
    picturePath ? loadImage(fs.readFileSync(picturePath)) : null,
    post.store ? loadBadge() : null,
  ]);
  const canvas = createCanvas(size[0], size[1]);
  drawPost(canvas.getContext('2d'), size[0], size[1], post, { icon, picture, badge, showCredit });
  return canvas.encode('jpeg', JPEG_QUALITY);
}
