import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { createImageStore } from '../src/images.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);

let root;
let store;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'wasla-images-'));
  store = createImageStore(root, { maxBytes: 1024 });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test('stores a picture under a generated name with the extension its bytes say', async () => {
  const png = await store.save(PNG);
  const jpeg = await store.save(JPEG);

  assert.match(png.file, /^[a-f0-9]{24}\.png$/);
  assert.match(jpeg.file, /^[a-f0-9]{24}\.jpg$/);
  assert.equal((await readdir(root)).length, 2);
});

test('refuses a file that is not an image, whatever it is called', async () => {
  const result = await store.save(Buffer.from('<?php echo 1; ?>'));
  assert.match(result.error, /PNG, JPEG or WebP/);
  assert.equal((await readdir(root)).length, 0);
});

test('refuses a picture over the size limit', async () => {
  const result = await store.save(Buffer.concat([PNG, Buffer.alloc(2048)]));
  assert.match(result.error, /larger/);
});

test('removes only names it could have generated', async () => {
  const { file } = await store.save(PNG);

  await store.remove('../../etc/passwd');
  await store.remove(file);

  assert.equal((await readdir(root)).length, 0);
});
