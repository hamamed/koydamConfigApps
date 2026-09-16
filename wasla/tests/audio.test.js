import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { createAudioStore, sniffAudio } from '../src/audio.js';

const pad = (head) => Buffer.concat([Buffer.from(head), Buffer.alloc(32)]);
const MP3_ID3 = pad([0x49, 0x44, 0x33, 0x04, 0x00]);
const MP3_FRAME = pad([0xff, 0xfb, 0x90, 0x64]);
const AAC = pad([0xff, 0xf1, 0x50, 0x80]);
const M4A = pad([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
const WAV = pad([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);

let root;
let store;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'wasla-audio-'));
  store = createAudioStore(root, { maxBytes: 1024 });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test('recognises mp3, aac, m4a and wav by their first bytes', () => {
  assert.equal(sniffAudio(MP3_ID3), 'mp3');
  assert.equal(sniffAudio(MP3_FRAME), 'mp3');
  assert.equal(sniffAudio(AAC), 'aac');
  assert.equal(sniffAudio(M4A), 'm4a');
  assert.equal(sniffAudio(WAV), 'wav');
  assert.equal(sniffAudio(Buffer.from('RIFF....WEBPVP8 ')), null);
});

test('stores a clip under a generated name with the extension its bytes say', async () => {
  const saved = await store.save(M4A);
  assert.match(saved.file, /^[a-f0-9]{24}\.m4a$/);
  assert.equal((await readdir(root)).length, 1);
});

test('refuses a file that is not audio, and one over the limit', async () => {
  assert.match((await store.save(Buffer.from('<html></html>'))).error, /MP3, M4A, AAC or WAV/);
  assert.match((await store.save(Buffer.concat([WAV, Buffer.alloc(2048)]))).error, /larger/);
  assert.equal((await readdir(root)).length, 0);
});

test('removes only names it could have generated', async () => {
  const { file } = await store.save(MP3_ID3);
  await store.remove('../wasla.db');
  await store.remove(file);
  assert.equal((await readdir(root)).length, 0);
});
