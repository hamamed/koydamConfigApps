import { randomBytes } from 'node:crypto';
import { access, mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isClipId } from './showcase.js';

/** A rendered clip is well under a megabyte; this leaves room for a hand-made one. */
export const MAX_CLIP_BYTES = 20 * 1024 * 1024;

/** The upload's own name is the cosmetic it belongs to. */
const CLIP_NAME = /^([A-Za-z0-9_-]+)\.mp4$/i;

/** An MP4 opens with a box whose type, at bytes 4 to 8, is `ftyp`. */
const looksLikeMp4 = (buffer) => buffer.length >= 12 && buffer.toString('latin1', 4, 8) === 'ftyp';

const megabytes = (bytes) => `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`;

const exists = (file) => access(file).then(() => true, () => false);

/**
 * Adds and removes showcase clips on disk.
 *
 * Everything is checked before a byte is written: the name must be a plain
 * cosmetic id, the bytes must be an MP4, and the id must be in the catalogue —
 * a clip for an id nothing asks for would sit there unseen forever. A clip is
 * written beside its final name and renamed into place, so the directory index
 * never lists a half-written file.
 *
 * @param {string} root directory holding `<cosmetic id>.mp4` files
 * @param {{ isKnownId: (id: string) => boolean, maxBytes?: number }} options
 */
export function createClipStore(root, { isKnownId, maxBytes = MAX_CLIP_BYTES } = {}) {
  if (typeof isKnownId !== 'function') throw new TypeError('createClipStore needs isKnownId');

  const target = (id) => path.join(root, `${id}.mp4`);

  /** @returns {Promise<{ ok: true, id: string, replaced: boolean } | { ok: false, reason: string }>} */
  async function storeClip({ buffer, filename }) {
    const match = CLIP_NAME.exec(String(filename ?? ''));
    if (!match) return { ok: false, reason: 'the name must be a cosmetic id followed by .mp4' };
    const id = match[1];

    if (!buffer?.length) return { ok: false, reason: 'the file is empty' };
    if (buffer.length > maxBytes) return { ok: false, reason: `the file is larger than ${megabytes(maxBytes)}` };
    if (!looksLikeMp4(buffer)) return { ok: false, reason: 'the file is not an MP4 video' };
    if (!isKnownId(id)) return { ok: false, reason: `no cosmetic has the id ${id}` };

    const destination = target(id);
    const partial = path.join(root, `.${id}.${randomBytes(4).toString('hex')}.uploading`);
    try {
      await mkdir(root, { recursive: true });
      const replaced = await exists(destination);
      await writeFile(partial, buffer);
      await rename(partial, destination);
      return { ok: true, id, replaced };
    } catch (error) {
      await rm(partial, { force: true });
      console.error(`showcase: could not store ${id}: ${error.message}`);
      return { ok: false, reason: 'it could not be written to disk' };
    }
  }

  /** @returns {Promise<{ ok: true, id: string } | { ok: false, reason: string }>} */
  async function deleteClip(id) {
    const clean = String(id ?? '');
    if (!isClipId(clean)) return { ok: false, reason: 'That is not a cosmetic id.' };

    try {
      await unlink(target(clean));
      return { ok: true, id: clean };
    } catch (error) {
      if (error.code === 'ENOENT') return { ok: false, reason: `No clip for ${clean}.` };
      console.error(`showcase: could not delete ${clean}: ${error.message}`);
      return { ok: false, reason: `The clip for ${clean} could not be removed.` };
    }
  }

  return { storeClip, deleteClip };
}
