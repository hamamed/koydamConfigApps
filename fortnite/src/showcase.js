import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { config } from './config.js';

const CLIP_EXTENSION = '.mp4';

/** How long a directory listing is trusted before the next lookup re-reads it. */
const REFRESH_MS = 5 * 60_000;

/** Where scripts/showcase-clips.js puts its output, resolved once. */
export const SHOWCASE_ROOT = path.resolve(config.showcaseDir);

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
 * @returns {{ refresh: () => Promise<void>, pathFor: (id: string) => string | null }}
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

  /** The clip's path on this host, or null when there is none. */
  const pathFor = (id) => {
    if (now() - loadedAt > refreshMs) refresh();
    return ids.has(id) ? `/showcase/${encodeURIComponent(id)}${CLIP_EXTENSION}` : null;
  };

  return { refresh, pathFor };
}

export const showcaseClips = createClipIndex(SHOWCASE_ROOT);
