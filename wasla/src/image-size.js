import fs from 'node:fs';

/**
 * A picture's pixel size, read from its header — the panel's preview needs the
 * shape to frame a picture the way the app does, and the app's own frame
 * follows the picture it loaded.
 *
 * PNG, JPEG and WebP: the three kinds the picture store accepts. Anything else,
 * or a file that cannot be read, gives null and the preview falls back to a square.
 */
export function imageSize(file) {
  let handle;
  try {
    handle = fs.openSync(file, 'r');
    // Enough for a PNG or WebP header and for the first JPEG segments.
    const head = Buffer.alloc(64 * 1024);
    const read = fs.readSync(handle, head, 0, head.length, 0);
    return sizeOf(head.subarray(0, read));
  } catch {
    return null;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

export function sizeOf(buffer) {
  return pngSize(buffer) ?? webpSize(buffer) ?? jpegSize(buffer);
}

const valid = (width, height) => (width > 0 && height > 0 ? { width, height } : null);

function pngSize(buffer) {
  if (buffer.length < 24) return null;
  if (!buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  return valid(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
}

function webpSize(buffer) {
  if (buffer.length < 30) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  const kind = buffer.toString('ascii', 12, 16);
  // VP8 (lossy), VP8L (lossless) and VP8X (extended) each keep the size elsewhere.
  if (kind === 'VP8 ') return valid(buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff);
  if (kind === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return valid((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  if (kind === 'VP8X') return valid(buffer.readUIntLE(24, 3) + 1, buffer.readUIntLE(27, 3) + 1);
  return null;
}

/** The size lives in the first frame header (SOF0..SOF15, minus the two DHT/DAC codes). */
function jpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < buffer.length) {
    if (buffer[at] !== 0xff) { at += 1; continue; }
    const marker = buffer[at + 1];
    // Padding between segments, and markers that carry no length.
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { at += 2; continue; }
    const length = buffer.readUInt16BE(at + 2);
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return valid(buffer.readUInt16BE(at + 7), buffer.readUInt16BE(at + 5));
    // Scan data follows; the size is always before it.
    if (marker === 0xda) return null;
    at += 2 + length;
  }
  return null;
}
