import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { Router } from 'express';

import { WALLPAPER_ROOT } from '../wallpapers/root.js';

/**
 * Wallpapers served from a folder on disk, with the folder name as the
 * category.
 *
 * Not from a database of URLs, which is what this was first: asking an admin
 * to find a hosted image and paste its address makes the panel depend on
 * somewhere else staying up, and there is nowhere obvious to host one. A file
 * you drop in a folder is the whole feature.
 *
 * The files themselves are served statically; this only describes them. Two
 * concerns kept apart on purpose — an image request should never touch the
 * scan, and the scan should never stream a file.
 */
export const wallpapersRouter = Router();

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/** Cached, because the app asks on every visit and the disk does not change often. */
let index = { at: 0, data: { items: [], categories: [] } };
const TTL_MS = 60_000;

export function forgetGallery() {
  index = { at: 0, data: { items: [], categories: [] } };
}

export async function gallery() {
  if (Date.now() - index.at < TTL_MS) return index.data;
  index = { at: Date.now(), data: await scan() };
  return index.data;
}

/**
 * Walks the gallery: files at the root are uncategorised, a subfolder's name is
 * the category.
 *
 * One level deep only. Someone organising their own originals into
 * `2026/september/` should not produce a category called "2026" in the app.
 */
async function scan() {
  let entries;
  try {
    entries = await readdir(WALLPAPER_ROOT, { withFileTypes: true });
  } catch {
    // No folder yet is an empty gallery, not a fault.
    return { items: [], categories: [] };
  }

  const items = [];
  const categories = new Set();

  for (const entry of entries) {
    if (entry.isDirectory()) {
      let inner = [];
      try {
        inner = await readdir(path.join(WALLPAPER_ROOT, entry.name), { withFileTypes: true });
      } catch {
        continue;
      }

      let found = 0;
      for (const file of inner) {
        if (!file.isFile() || !IMAGE_EXTENSIONS.has(path.extname(file.name).toLowerCase())) continue;
        const described = await describe(`${entry.name}/${file.name}`, entry.name);
        if (described) { items.push(described); found += 1; }
      }

      // Only a category if something is in it — an empty folder should not
      // appear in the app as a section with nothing behind it.
      if (found > 0) categories.add(entry.name);
      continue;
    }

    if (!entry.isFile() || !IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const described = await describe(entry.name, null);
    if (described) items.push(described);
  }

  items.sort((a, b) => b.modified.localeCompare(a.modified));
  return { items, categories: [...categories].sort() };
}

async function describe(relativeId, category) {
  try {
    const info = await stat(path.join(WALLPAPER_ROOT, relativeId));
    return {
      id: relativeId,
      title: path.basename(relativeId, path.extname(relativeId)).replace(/[-_]+/g, ' '),
      category,
      bytes: info.size,
      modified: info.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

/** `GET /api/v1/wallpapers` — the index the app reads. */
wallpapersRouter.get('/wallpapers', async (req, res) => {
  const data = await gallery();

  // Built from the request rather than a configured hostname: this box is
  // reached by domain now and could be reached by IP in a pinch, and a baked-in
  // host breaks the images on whichever one it was not.
  const origin = `${req.protocol}://${req.get('host')}`;

  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    status: 'success',
    data: data.items.map((item) => ({
      ...item,
      // Encoded per segment, not whole: encodeURIComponent on the id would turn
      // the folder separator into %2F and the file would 404. Uploaded names
      // can hold a space, an apostrophe or any non-ASCII character, each of
      // which otherwise produces a URL the app cannot fetch and a broken image
      // with nothing to explain it.
      image: `${origin}/wallpapers/${item.id.split('/').map(encodeURIComponent).join('/')}`,
      thumb: null,
    })),
    meta: { categories: data.categories },
  });
});
