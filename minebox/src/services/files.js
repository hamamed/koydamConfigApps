/**
 * The downloadable payload.
 *
 * Everything except a seed has exactly one file behind it, and this is the only code that puts
 * one on disk or takes it off again.
 *
 * ## Stored under a generated name, served under the uploader's
 *
 * On disk a file is `dragon-mounts-a7f3c9d2.mcaddon` — slug plus a slice of the item id — so
 * two uploads called `pack.mcaddon` cannot overwrite each other and nothing on the filesystem
 * depends on a name a browser supplied. What the client downloads is the *original* name,
 * carried in the Content-Disposition header, because Minecraft lists an imported pack under
 * whatever the file was called and `a7f3c9d2.mcaddon` is not a name anyone wants in their
 * pack list.
 *
 * ## Not re-encoded
 *
 * Unlike an image, an archive is stored byte for byte. Re-zipping would change the checksums
 * creators publish alongside their packs, and any normalisation risks producing an archive
 * Minecraft reads differently from the one that was tested.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { FORMATS, MAX_BYTES, KIND_LABELS, extensionOf } from '../utils/validate.js';
import { measureDirectory } from './previews.js';

const FILES_DIR = path.join(config.storageDir, 'files');

export async function ensureFileDir() {
  await fs.mkdir(FILES_DIR, { recursive: true });
}

/**
 * Writes an upload to storage.
 *
 * The per-kind size ceiling is checked here rather than only in multer, because multer's limit
 * is one number for the whole route and the route accepts both a 6 KB skin and a 60 MB world.
 * A 40 MB "skin" is not a skin, and letting it through means the app downloads it before
 * Minecraft rejects it.
 */
export async function storeFile(buffer, filename, kind) {
  await ensureFileDir();

  const ceiling = MAX_BYTES[kind] ?? config.maxUploadBytes;
  if (buffer.length > ceiling) {
    throw Object.assign(
      new Error(
        `That file is ${megabytes(buffer.length)} MB. A ${KIND_LABELS[kind].toLowerCase()} may be `
        + `at most ${megabytes(ceiling)} MB.`,
      ),
      { status: 400 },
    );
  }

  await fs.writeFile(path.join(FILES_DIR, filename), buffer);

  return {
    filename,
    ext: extensionOf(filename),
    bytes: buffer.length,
    install: FORMATS[extensionOf(filename)]?.install || 'zip',
  };
}

function megabytes(bytes) {
  const value = bytes / (1024 * 1024);
  return value < 10 ? value.toFixed(1) : Math.round(value);
}

/**
 * The absolute path of a stored file, or null if the name is not one we wrote.
 *
 * The name comes from the database rather than from a request, so this is belt and braces —
 * but a path built by joining a stored string is exactly the shape of bug that turns a
 * corrupted row into an arbitrary file read, and the check costs nothing.
 */
export function pathFor(filename) {
  if (!filename) return null;

  const resolved = path.resolve(FILES_DIR, filename);
  const root = path.resolve(FILES_DIR);

  if (resolved !== path.join(root, path.basename(resolved))) return null;
  return resolved;
}

/** Removes a stored file. A missing file is not an error — deletion should be idempotent. */
export async function removeFile(filename) {
  const target = pathFor(filename);
  if (!target) return;
  await fs.rm(target, { force: true }).catch(() => {});
}

export async function fileUsage() {
  return measureDirectory(FILES_DIR);
}
