import path from 'node:path';

/**
 * The decisions behind cutting a clip from a showcase video, kept apart from
 * the downloading and encoding so they can be tested: whose videos may be
 * used, which seconds to take, where the skin is, and which window to keep.
 */

/** Past the in-game info popup that opens most showcases. */
export const CLIP_START_SECONDS = 2;
export const CLIP_LENGTH_SECONDS = 12;
/** Below this there is not enough of the skin to make a clip worth showing. */
export const MIN_CLIP_SECONDS = 6;

/**
 * Which part of a video to use: CLIP_LENGTH_SECONDS from CLIP_START_SECONDS in,
 * starting earlier or ending sooner for a short video rather than running past
 * its end — where the footage would silently freeze on its last frame.
 *
 * @param {number} sourceDuration seconds
 * @returns {{ start: number, duration: number } | null} null when too short or unknown
 */
export function clipTiming(sourceDuration) {
  if (!Number.isFinite(sourceDuration) || sourceDuration < MIN_CLIP_SECONDS) return null;
  const start = Math.min(CLIP_START_SECONDS, Math.max(0, sourceDuration - CLIP_LENGTH_SECONDS));
  return { start, duration: Math.min(CLIP_LENGTH_SECONDS, sourceDuration - start) };
}

/** Whether a path yt-dlp reported is inside the directory it was told to write to. */
export function isInside(file, dir) {
  const relative = path.relative(path.resolve(dir), path.resolve(file));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Channels whose showcase videos may be cut into clips — the ones that gave
 * permission. A video from any other channel is not downloaded.
 */
export const PERMITTED_CHANNELS = Object.freeze(['Gnejs Gaming']);

export function isPermittedChannel(channel) {
  return typeof channel === 'string' && PERMITTED_CHANNELS.includes(channel);
}

/**
 * The area that moved, from ffmpeg cropdetect's log over a frame difference.
 *
 * With reset=0 the box only grows, so the last line covers every frame. A box
 * whose right edge is not right of its left edge means nothing moved.
 *
 * @param {string} log ffmpeg's stderr
 * @returns {{ x1: number, x2: number, y1: number, y2: number } | null}
 */
export function parseMotionBox(log) {
  const boxes = [...String(log ?? '').matchAll(/x1:(-?\d+) x2:(-?\d+) y1:(-?\d+) y2:(-?\d+)/g)];
  if (boxes.length === 0) return null;
  const [x1, x2, y1, y2] = boxes.at(-1).slice(1).map(Number);
  return x2 > x1 ? { x1, x2, y1, y2 } : null;
}

/** The horizontal middle of the moving area, or null when there was none. */
export function motionCenter(box) {
  return box ? Math.round((box.x1 + box.x2) / 2) : null;
}

const evenFloor = (n) => Math.floor(n / 2) * 2;

/**
 * The source window with the card's shape, as tall as the usable height —
 * everything above the channel's banner. Even, as the encoder needs.
 */
export function cropSize(card, usableHeight) {
  return { width: evenFloor((usableHeight * card.width) / card.height), height: usableHeight };
}

/**
 * The window to cut: the card's shape at the full usable height, or — for a
 * source too narrow for that, like a portrait video — the source's full width
 * with the height that shape gives it, never taller than the usable height.
 */
export function fitCrop(card, usableHeight, sourceWidth) {
  const full = cropSize(card, usableHeight);
  if (full.width <= sourceWidth) return full;
  const width = evenFloor(sourceWidth);
  return { width, height: Math.min(usableHeight, evenFloor((width * card.height) / card.width)) };
}

/**
 * The window's left edge: centred on the skin, kept inside the frame, and on
 * the middle of the frame when no movement was found to centre on.
 */
export function cropWindow(center, sourceWidth, cropWidth) {
  const ideal = center == null ? (sourceWidth - cropWidth) / 2 : center - cropWidth / 2;
  const clamped = Math.max(0, Math.min(sourceWidth - cropWidth, ideal));
  return evenFloor(clamped);
}
