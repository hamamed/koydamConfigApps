import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { createClipStore } from '../src/showcase-store.js';

/** The smallest buffer that reads as an MP4: a box size, then `ftyp`. */
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12)]);
const KNOWN = new Set(['Character_AgentSherbert', 'Character_Inferno']);

let root;
let store;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'clip-store-test-'));
  store = createClipStore(root, { isKnownId: (id) => KNOWN.has(id), maxBytes: 1024 });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test('stores a clip under its cosmetic id', async () => {
  const result = await store.storeClip({ buffer: MP4, filename: 'Character_AgentSherbert.mp4' });

  assert.deepEqual(result, { ok: true, id: 'Character_AgentSherbert', replaced: false });
  assert.deepEqual(await readFile(path.join(root, 'Character_AgentSherbert.mp4')), MP4);
});

test('replacing a clip says so and leaves no partial file behind', async () => {
  await store.storeClip({ buffer: MP4, filename: 'Character_Inferno.mp4' });

  const result = await store.storeClip({ buffer: MP4, filename: 'Character_Inferno.MP4' });

  assert.equal(result.ok, true);
  assert.equal(result.replaced, true);
  assert.deepEqual(await readdir(root), ['Character_Inferno.mp4']);
});

test('refuses a name that is not a plain cosmetic id', async () => {
  for (const filename of ['../Character_Inferno.mp4', 'Character Inferno.mp4', 'Character_Inferno.mov', 'Character_Inferno']) {
    const result = await store.storeClip({ buffer: MP4, filename });
    assert.equal(result.ok, false, filename);
    assert.match(result.reason, /name/i, filename);
  }
  assert.deepEqual(await readdir(root), []);
});

test('refuses a file that is not an MP4, whatever it is called', async () => {
  const result = await store.storeClip({ buffer: Buffer.from('<html>not a video</html>'), filename: 'Character_Inferno.mp4' });

  assert.equal(result.ok, false);
  assert.match(result.reason, /mp4/i);
});

test('refuses an empty or oversized file', async () => {
  assert.equal((await store.storeClip({ buffer: Buffer.alloc(0), filename: 'Character_Inferno.mp4' })).ok, false);

  const big = Buffer.concat([MP4, Buffer.alloc(2048)]);
  const result = await store.storeClip({ buffer: big, filename: 'Character_Inferno.mp4' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /large/i);
});

test('refuses a clip for a cosmetic the catalogue does not have', async () => {
  const result = await store.storeClip({ buffer: MP4, filename: 'Character_Nobody.mp4' });

  assert.equal(result.ok, false);
  assert.match(result.reason, /no cosmetic/i);
  assert.equal(existsSync(path.join(root, 'Character_Nobody.mp4')), false);
});

test('creates the clip directory when it does not exist yet', async () => {
  const nested = createClipStore(path.join(root, 'fresh', 'showcase'), { isKnownId: () => true });

  const result = await nested.storeClip({ buffer: MP4, filename: 'Character_Inferno.mp4' });

  assert.equal(result.ok, true);
});

test('deletes a clip', async () => {
  await writeFile(path.join(root, 'Character_Inferno.mp4'), MP4);

  const result = await store.deleteClip('Character_Inferno');

  assert.deepEqual(result, { ok: true, id: 'Character_Inferno' });
  assert.equal(existsSync(path.join(root, 'Character_Inferno.mp4')), false);
});

test('deleting a clip that is not there is reported, not thrown', async () => {
  const result = await store.deleteClip('Character_Inferno');

  assert.equal(result.ok, false);
  assert.match(result.reason, /no clip/i);
});

test('refuses to delete by anything but a plain id', async () => {
  await writeFile(path.join(root, 'keep.mp4'), MP4);

  for (const id of ['../keep', 'keep/../keep', '', 'Character Inferno']) {
    const result = await store.deleteClip(id);
    assert.equal(result.ok, false, id);
  }
  assert.equal(existsSync(path.join(root, 'keep.mp4')), true);
});
