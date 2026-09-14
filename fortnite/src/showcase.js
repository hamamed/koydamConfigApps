import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { config } from './config.js';

const CLIP_EXTENSION = '.mp4';

/**
 * Beside each clip, a small JSON note of where it came from:
 * `{ "source": "youtube", "channel": "…" }` or `{ "source": "artwork" }`.
 * Written by the render scripts; a clip without one is of unknown source.
 */
export const SOURCE_SUFFIX = '.source.json';
const SOURCES = new Set(['youtube', 'artwork']);

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

/** The source a note names, or null for a note that is missing, unreadable or names nothing known. */
async function readSource(file) {
  try {
    const note = JSON.parse(await readFile(file, 'utf8'));
    return SOURCES.has(note?.source) ? note.source : null;
  } catch {
    return null;
  }
}

/**
 * Which cosmetics have a clip, which version, and where it came from —
 * answered from memory.
 *
 * A cosmetics page is forty rows, and asking the disk forty times per request
 * to learn what changes only when someone renders or uploads is waste. The
 * listing is kept in a map and re-read in the background once it is older than
 * `refreshMs`, so newly uploaded clips appear within minutes without a restart.
 *
 * @param {string} root directory holding `<cosmetic id>.mp4` files
 * @param {{ refreshMs?: number, now?: () => number }} [options]
 */
export function createClipIndex(root, { refreshMs = REFRESH_MS, now = Date.now } = {}) {
  let clips = new Map();
  let loadedAt = -Infinity;
  let pending = null;

  const read = async () => {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
      const listed = await Promise.all(
        [...files]
          .filter((name) => name.endsWith(CLIP_EXTENSION))
          .map(async (name) => {
            const id = name.slice(0, -CLIP_EXTENSION.length);
            try {
              const { mtimeMs } = await stat(path.join(root, name));
              const note = `${id}${SOURCE_SUFFIX}`;
              const source = files.has(note) ? await readSource(path.join(root, note)) : null;
              return [id, { version: versionOf(mtimeMs), source }];
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
    const clip = clips.get(id);
    return clip ? clipPath(id, clip.version) : null;
  };

  /** Where the clip came from — 'youtube', 'artwork' — or null when unknown or there is no clip. */
  const sourceOf = (id) => {
    refreshIfStale();
    return clips.get(id)?.source ?? null;
  };

  /** Every cosmetic id that has a clip. A copy, so a caller cannot change the index. */
  const listIds = () => {
    refreshIfStale();
    return new Set(clips.keys());
  };

  /** Every cosmetic id whose clip came from `source`. */
  const idsFrom = (source) => {
    refreshIfStale();
    return new Set([...clips].filter(([, clip]) => clip.source === source).map(([id]) => id));
  };

  return { refresh, reload, pathFor, sourceOf, ids: listIds, idsFrom };
}

export const showcaseClips = createClipIndex(SHOWCASE_ROOT);
