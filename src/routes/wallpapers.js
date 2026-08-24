import { Router } from 'express';
import { readdir, stat, open } from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';
import { cached } from '../cache/store.js';
import { asyncRoute } from '../middleware/errors.js';
import { log } from '../log.js';

/**
 * Wallpapers served from a folder on disk.
 *
 * Not from the upstream API: Supercell publishes map renders at 690×1050 and
 * brawler splashes at 200×200, and neither is a phone wallpaper. This lets you
 * drop real artwork into a directory and have it appear in the app, with the
 * folder name as its category.
 */
export const wallpapersRouter = Router();

/** The extensions we will list. Anything else in the folder is ignored. */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/** Root of the gallery, resolved once. */
export const WALLPAPER_ROOT = path.resolve(config.wallpapers.dir);

/**
 * GET /wallpapers — the index.
 *
 * The files themselves are served statically (see server.js); this only
 * describes them. Two separate concerns on purpose: an image request should
 * never touch this scan, and the scan should never stream a file.
 */
wallpapersRouter.get(
  '/wallpapers',
  asyncRoute(async (req, res) => {
    const { data, cached: hit } = await cached(
      'wallpapers:index',
      config.wallpapers.ttl,
      () => scanGallery(),
    );

    // Absolute URLs built from the request rather than a configured hostname:
    // the app reaches this box by IP today and by domain later, and a baked-in
    // host would break the images on whichever one it wasn't.
    const origin = `${req.protocol}://${req.get('host')}`;

    res.set('Cache-Control', `public, max-age=${config.wallpapers.ttl}`);
    res.json({
      count: data.items.length,
      categories: data.categories,
      cached: hit,
      items: data.items.map((item) => ({
        ...item,
        // Encoded per segment, not whole: `encodeURIComponent` on the id would
        // turn the folder separator into %2F and the file would 404.
        //
        // Uploaded filenames are arbitrary — a space, a `#`, an apostrophe or
        // any non-ASCII character produces a URL the client cannot fetch, and
        // the app shows a broken-image icon with nothing to explain it.
        url: `${origin}/wallpapers/${item.id
          .split('/')
          .map(encodeURIComponent)
          .join('/')}`,
      })),
    });
  }),
);

/**
 * Walks the gallery one level deep.
 *
 * Files at the root are uncategorised; a subfolder's name is the category.
 * Deeper nesting is ignored rather than flattened — a folder someone made to
 * organise their own originals should not turn into a category in the app.
 */
async function scanGallery() {
  let entries;
  try {
    entries = await readdir(WALLPAPER_ROOT, { withFileTypes: true });
  } catch (err) {
    // A missing folder is the normal state of a fresh install, not a fault.
    // Empty is the honest answer and the app renders it as "nothing yet".
    if (err.code === 'ENOENT') {
      log.info('Wallpaper folder does not exist yet', {
        dir: WALLPAPER_ROOT,
      });
      return { items: [], categories: [] };
    }
    throw err;
  }

  const items = [];
  const categories = new Set();

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const category = entry.name;
      let inner;
      try {
        inner = await readdir(path.join(WALLPAPER_ROOT, category), {
          withFileTypes: true,
        });
      } catch {
        continue;
      }

      let found = 0;
      for (const file of inner) {
        if (!file.isFile()) continue;
        const item = await describe(`${category}/${file.name}`, category);
        if (item) {
          items.push(item);
          found += 1;
        }
      }
      // Only a category if something is actually in it — an empty folder
      // would otherwise show as a filter chip that matches nothing.
      if (found > 0) categories.add(category);
      continue;
    }

    if (!entry.isFile()) continue;
    const item = await describe(entry.name, null);
    if (item) items.push(item);
  }

  // Newest first: the reason to add a wallpaper is for people to see it.
  items.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));

  return { items, categories: [...categories].sort() };
}

/** Describes one file, or null if it isn't an image we serve. */
async function describe(relativeId, category) {
  const ext = path.extname(relativeId).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return null;

  const absolute = path.join(WALLPAPER_ROOT, relativeId);

  // Defence in depth. express.static already refuses to escape its root, but
  // this index builds paths from directory entries, and a symlink pointing out
  // of the gallery would otherwise be advertised as if it belonged there.
  if (!absolute.startsWith(WALLPAPER_ROOT + path.sep)) return null;

  let info;
  try {
    info = await stat(absolute);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;

  const size = await readDimensions(absolute, ext).catch(() => null);

  return {
    id: relativeId.split(path.sep).join('/'),
    name: prettyName(path.basename(relativeId, ext)),
    category,
    bytes: info.size,
    updatedAt: info.mtime.toISOString(),
    width: size?.width ?? null,
    height: size?.height ?? null,
  };
}

/** `cool-shelly_01.png` → `Cool Shelly 01`. */
function prettyName(base) {
  const spaced = base.replace(/[_-]+/g, ' ').trim();
  return spaced
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Pixel dimensions, read from the file header only.
 *
 * Worth the trouble because the app grids these: without a real aspect ratio
 * every tile would have to assume one, and a portrait wallpaper in a landscape
 * tile is cropped to nonsense. Reads at most a few KB and never decodes.
 *
 * Returns null for anything it doesn't confidently understand — a wrong guess
 * here is worse than no answer, since the client falls back to a sane default.
 */
async function readDimensions(file, ext) {
  const handle = await open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read({
      buffer: Buffer.alloc(65_536),
      position: 0,
    });
    if (bytesRead < 24) return null;

    if (ext === '.png') return pngSize(buffer, bytesRead);
    if (ext === '.webp') return webpSize(buffer, bytesRead);
    return jpegSize(buffer, bytesRead);
  } finally {
    await handle.close();
  }
}

function pngSize(b, len) {
  // 8-byte signature, then an IHDR chunk whose width/height are big-endian at
  // offsets 16 and 20.
  if (len < 24) return null;
  if (b.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function webpSize(b, len) {
  if (len < 30) return null;
  if (b.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (b.toString('ascii', 8, 12) !== 'WEBP') return null;

  const format = b.toString('ascii', 12, 16);

  // Lossy: 14-bit dimensions after the start code, minus one.
  if (format === 'VP8 ') {
    return {
      width: b.readUInt16LE(26) & 0x3fff,
      height: b.readUInt16LE(28) & 0x3fff,
    };
  }

  // Lossless: 14 bits each, packed across four bytes, both stored minus one.
  if (format === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }

  // Extended: 24-bit dimensions, minus one.
  if (format === 'VP8X') {
    return {
      width: (b.readUIntLE(24, 3) & 0xffffff) + 1,
      height: (b.readUIntLE(27, 3) & 0xffffff) + 1,
    };
  }

  return null;
}

function jpegSize(b, len) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 9 < len) {
    if (b[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = b[offset + 1];

    // SOF0..SOF15, excluding the four that are not frame headers. Height and
    // width sit three and five bytes into the segment payload.
    const isFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;

    if (isFrame) {
      return {
        height: b.readUInt16BE(offset + 5),
        width: b.readUInt16BE(offset + 7),
      };
    }

    // Padding and standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    const segment = b.readUInt16BE(offset + 2);
    if (segment < 2) return null;
    offset += 2 + segment;
  }

  // Only the first 64KB is read, and a JPEG with a huge EXIF block can push the
  // frame header past that. Null rather than a guess.
  return null;
}
