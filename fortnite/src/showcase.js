import { readdir, stat } from 'node:fs/promises';
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

/**
 * The path a cosmetic's clip is served at on this host.
 *
 * The version is part of the link because clips are cached for a week: a clip
 * re-rendered under the same name kept showing its old self to anyone who had
 * seen it. A new file gets a new version, so a new link, so a fresh fetch.
 */
export function clipPath(id, version = null) {
  const base = `/showcase/${encodeURIComponent(id)}${CLIP_EXTENSION}`;
  return version ? `${base}?v=${version}` : base;
}

/** A short, URL-safe version from a file's modification time. */
const versionOf = (mtimeMs) => Math.trunc(mtimeMs).toString(36);

/**
 * Which cosmetics have a rendered clip, and which version of it, answered from
 * memory.
 *
 * A cosmetics page is forty rows, and asking the disk forty times per request
 * to learn what changes only when someone renders or uploads is waste. The
 * listing is kept in a map and re-read in the background once it is older than
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
  let clips = new Map();
  let loadedAt = -Infinity;
  let pending = null;

  const read = async () => {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      const listed = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(CLIP_EXTENSION))
          .map(async (entry) => {
            try {
              const { mtimeMs } = await stat(path.join(root, entry.name));
              return [entry.name.slice(0, -CLIP_EXTENSION.length), versionOf(mtimeMs)];
            } catch {
              // Deleted between the listing and the stat: it is simply not there.
              return null;
            }
          }),
      );
      clips = new Map(listed.filter(Boolean));
    } catch (error) {
      // No directory yet is the normal state before the first render: no clips.
      // Anything else keeps the last good listing rather than blanking every clip.
      if (error.code === 'ENOENT') clips = new Map();
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

  /** The clip's versioned path on this host, or null when there is none. */
  const pathFor = (id) => {
    refreshIfStale();
    return clips.has(id) ? clipPath(id, clips.get(id)) : null;
  };

  /** Every cosmetic id that has a clip. A copy, so a caller cannot change the index. */
  const listIds = () => {
    refreshIfStale();
    return new Set(clips.keys());
  };

  return { refresh, reload, pathFor, ids: listIds };
}

export const showcaseClips = createClipIndex(SHOWCASE_ROOT);
