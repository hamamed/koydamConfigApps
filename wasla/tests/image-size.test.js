import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import { imageSize, sizeOf } from '../src/image-size.js';

/** The smallest valid PNG header for the given size: signature + IHDR. */
function png(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const chunk = Buffer.concat([Buffer.from('IHDR'), ihdr]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(ihdr.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(chunk) : 0);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), length, chunk, crc]);
}

/** A JPEG with one comment segment before the frame header, as cameras write. */
function jpeg(width, height) {
  const comment = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x06]), Buffer.from('abcd')]);
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(8 + 3, 2); // length
  sof[4] = 8; // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 1; // one component
  return Buffer.concat([Buffer.from([0xff, 0xd8]), comment, sof, Buffer.from([0xff, 0xda])]);
}

function webpLossy(width, height) {
  const buffer = Buffer.alloc(40);
  buffer.write('RIFF', 0, 'ascii');
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8 ', 12, 'ascii');
  buffer.writeUInt16LE(width, 26);
  buffer.writeUInt16LE(height, 28);
  return buffer;
}

test('a PNG, a JPEG and a WebP each give their pixel size', () => {
  assert.deepEqual(sizeOf(png(320, 126)), { width: 320, height: 126 });
  assert.deepEqual(sizeOf(jpeg(1200, 800)), { width: 1200, height: 800 });
  assert.deepEqual(sizeOf(webpLossy(640, 480)), { width: 640, height: 480 });
});

test('anything else, or a broken header, gives null rather than a guess', () => {
  assert.equal(sizeOf(Buffer.from('not a picture at all')), null);
  assert.equal(sizeOf(Buffer.alloc(0)), null);
  assert.equal(sizeOf(png(0, 0)), null);
});

test('a file is read from its header alone, and a missing file gives null', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wasla-size-'));
  const file = path.join(folder, 'flag.png');
  fs.writeFileSync(file, Buffer.concat([png(900, 600), Buffer.alloc(4096)]));
  assert.deepEqual(imageSize(file), { width: 900, height: 600 });
  assert.equal(imageSize(path.join(folder, 'gone.png')), null);
  fs.rmSync(folder, { recursive: true, force: true });
});
