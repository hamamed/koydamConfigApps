import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { WALLPAPER_ROOT } from '../routes/wallpapers.js';

/**
 * Writing to the wallpaper gallery.
 *
 * Everything here exists because a filename and a category arrive from a
 * browser and become a path on disk. `express.static` already refuses to serve
 * outside its root, but that protects reads - this module is the write side,
 * and nothing downstream would stop `../../etc/cron.d/x` on the way in.
 *
 * So names are not sanitised, they are *rebuilt*: only characters from a known
 * alphabet survive, and the result is checked against the root afterwards.
 * Stripping bad characters from an attacker-supplied string is a guessing
 * game; constructing a new string from a safe alphabet is not.
 */

/** What the gallery serves, so anything else is pointless to store. */
export const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/** Matches what the app can decode, and keeps one upload from filling a disk. */
export const MAX_BYTES = 12 * 1024 * 1024;

/**
 * The first bytes of each format we accept.
 *
 * Checked because a browser's declared content-type is whatever the client
 * says it is, and a renamed .exe is not a wallpaper. This is not a full parse -
 * it is the cheap check that catches the honest mistake and the lazy attempt.
 */
const MAGIC = [
  { ext: '.png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { ext: '.jpg', bytes: [0xff, 0xd8, 0xff] },
  // RIFF....WEBP - the middle four bytes are a length, so they are skipped.
  { ext: '.webp', bytes: [0x52, 0x49, 0x46, 0x46], at8: [0x57, 0x45, 0x42, 0x50] },
];

export function sniffFormat(buffer) {
  if (!buffer || buffer.length < 12) return null;

  for (const sig of MAGIC) {
    const headMatches = sig.bytes.every((b, i) => buffer[i] === b);
    if (!headMatches) continue;

    if (sig.at8) {
      const tailMatches = sig.at8.every((b, i) => buffer[8 + i] === b);
      if (!tailMatches) continue;
    }
    return sig.ext;
  }
  return null;
}

/**
 * A safe slug, built rather than filtered.
 *
 * Lowercase letters, digits and single hyphens. Anything else is dropped, so
 * `../../etc/passwd` becomes `etc-passwd` and cannot climb anywhere.
 */
export function slug(input, fallback = 'wallpaper') {
  const s = String(input ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  return s || fallback;
}

/**
 * Where a file should land, or null if the request is not acceptable.
 *
 * Returns absolute and relative forms: the relative one is the gallery's id
 * and what the panel shows, the absolute one is what gets written.
 */
export function resolveTarget(category, filename, ext) {
  if (!ALLOWED_EXTENSIONS.has(ext)) return null;

  const base = slug(path.basename(String(filename ?? ''), path.extname(String(filename ?? ''))));
  const folder = category ? slug(category, '') : '';

  const relative = folder ? `${folder}/${base}${ext}` : `${base}${ext}`;
  const absolute = path.resolve(WALLPAPER_ROOT, relative);

  // The belt to the braces above. If the constructed path is not inside the
  // gallery, something in the reasoning is wrong and the write must not happen.
  if (absolute !== WALLPAPER_ROOT && !absolute.startsWith(WALLPAPER_ROOT + path.sep)) {
    return null;
  }

  return { relative, absolute, folder, base, ext };
}

/** Adds -2, -3 … rather than overwriting. Replacing a wallpaper someone is
 *  already looking at should be a deliberate delete, not a name collision. */
async function uniquePath(target) {
  let candidate = target;
  let n = 2;

  for (;;) {
    try {
      await stat(candidate.absolute);
    } catch {
      return candidate;
    }

    const base = `${target.base}-${n}`;
    const relative = target.folder ? `${target.folder}/${base}${target.ext}` : `${base}${target.ext}`;
    candidate = {
      ...target,
      base,
      relative,
      absolute: path.resolve(WALLPAPER_ROOT, relative),
    };
    n += 1;

    // A folder with thousands of same-named files is a bug somewhere else;
    // failing is better than looping.
    if (n > 500) return null;
  }
}

/**
 * Stores one uploaded image.
 *
 * Written to a temporary name in the same folder and then renamed, because
 * rename is atomic on the same filesystem: the gallery scanner runs on a timer
 * and must never see a half-written file and index it as a wallpaper.
 */
export async function storeWallpaper({ buffer, filename, category }) {
  if (!buffer?.length) return { ok: false, reason: 'The file was empty.' };

  if (buffer.length > MAX_BYTES) {
    return {
      ok: false,
      reason: `That file is ${(buffer.length / 1048576).toFixed(1)} MB; the limit is ${MAX_BYTES / 1048576} MB.`,
    };
  }

  const sniffed = sniffFormat(buffer);
  if (!sniffed) {
    return { ok: false, reason: 'That is not a PNG, JPEG or WebP image.' };
  }

  // The real format wins over the declared extension: a .png that is actually
  // a JPEG should be stored as what it is, so the browser decodes it.
  const target = resolveTarget(category, filename, sniffed);
  if (!target) return { ok: false, reason: 'That name or category cannot be used.' };

  const unique = await uniquePath(target);
  if (!unique) return { ok: false, reason: 'Too many files with that name.' };

  const dir = path.dirname(unique.absolute);
  await mkdir(dir, { recursive: true });

  const temp = `${unique.absolute}.uploading`;
  const { writeFile } = await import('node:fs/promises');

  await writeFile(temp, buffer);
  await rename(temp, unique.absolute);

  return { ok: true, id: unique.relative, bytes: buffer.length };
}

/**
 * Removes one wallpaper by its gallery id.
 *
 * The id comes from a URL, so it is re-resolved and re-checked rather than
 * trusted - the same string that indexes a file is the one that would delete
 * an arbitrary path if it were joined naively.
 */
export async function deleteWallpaper(id) {
  const raw = String(id ?? '');
  if (!raw || raw.includes('\0')) return { ok: false, reason: 'Not a valid id.' };

  const absolute = path.resolve(WALLPAPER_ROOT, raw);

  if (!absolute.startsWith(WALLPAPER_ROOT + path.sep)) {
    return { ok: false, reason: 'That path is outside the gallery.' };
  }

  if (!ALLOWED_EXTENSIONS.has(path.extname(absolute).toLowerCase())) {
    return { ok: false, reason: 'That is not a wallpaper.' };
  }

  let info;
  try {
    info = await stat(absolute);
  } catch {
    return { ok: false, reason: 'No such wallpaper.' };
  }

  // Directories are not deletable through this: one mistyped id should not be
  // able to remove a whole category.
  if (!info.isFile()) return { ok: false, reason: 'That is not a file.' };

  await rm(absolute);
  return { ok: true, id: raw };
}
