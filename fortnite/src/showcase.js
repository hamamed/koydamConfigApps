import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { config } from './config.js';

const CLIP_EXTENSION = '.mp4';

/** How long a directory listing is trusted before the next lookup re-reads it. */
const REFRESH_MS = 5 * 60_000;

/** Where scripts/showcase-clips.js puts its output, resolved once. */
export const SHOWCASE_ROOT = path.resolve(config.showcaseDir);

const CLIP_ID = /^[A-Za-z0-9_-]+$/;

/** Whether a value can name a clip file. Upstream ids all have this shape. */
export function isClipId(id) {
  return typeof id === 'string' && CLIP_ID.test(id);
}

/** The path a cosmetic's clip is served at on this host. */
export function clipPath(id) {
  return `/showcase/${encodeURIComponent(id)}${CLIP_EXTENSION}`;
}

/**
 * Which cosmetics have a rendered clip, answered from memory.
 *
 * A cosmetics page is forty rows, and asking the disk forty times per request
 * to learn what changes only when someone runs the render script is waste. The
 * listing is kept in a set and re-read in the background once it is older than
 * `refreshMs`, so newly uploaded clips appear within minutes without a restart.
 *
 * @param {string} root directory holding `<cosmetic id>.mp4` files
 * @param {{ refreshMs?: number, now?: () => number }} [options]
 * @returns {{
 *   refresh: () => Promise<void>,
 *   reload: () => Promise<void>,
 *   pathFor: (id: string) => string | null,
 *   ids: () => Set<string>,
 * }}
 */
export function createClipIndex(root, { refreshMs = REFRESH_MS, now = Date.now } = {}) {
  let ids = new Set();
  let loadedAt = -Infinity;
  let pending = null;

  const read = async () => {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      ids = new Set(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(CLIP_EXTENSION))
          .map((entry) => entry.name.slice(0, -CLIP_EXTENSION.length)),
      );
    } catch (error) {
      // No directory yet is the normal state before the first render: no clips.
      // Anything else keeps the last good listing rather than blanking every clip.
      if (error.code === 'ENOENT') ids = new Set();
      else console.error(`showcase: cannot list ${root}: ${error.message}`);
    } finally {
      loadedAt = now();
      pending = null;
    }
  };

  /** Re-reads the directory; concurrent callers share one read. Never rejects. */
  const refresh = () => {
    pending ??= read();
    return pending;
  };

  /**
   * A read that starts after this call, for right after an upload or delete.
   * Joining a read already in flight could return a listing taken before the change.
   */
  const reload = async () => {
    if (pending) await pending;
    return refresh();
  };

  const refreshIfStale = () => {
    if (now() - loadedAt > refreshMs) refresh();
  };

  /** The clip's path on this host, or null when there is none. */
  const pathFor = (id) => {
    refreshIfStale();
    return ids.has(id) ? clipPath(id) : null;
  };

  /** Every cosmetic id that has a clip. A copy, so a caller cannot change the index. */
  const listIds = () => {
    refreshIfStale();
    return new Set(ids);
  };

  return { refresh, reload, pathFor, ids: listIds };
}

export const showcaseClips = createClipIndex(SHOWCASE_ROOT);
