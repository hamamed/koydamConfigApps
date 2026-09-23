import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, before, test } from 'node:test';

// config.js reads the environment when it is first imported, so the token has
// to be in place before anything pulls it in — hence the dynamic imports.
const TOKEN = 'k'.repeat(64);
process.env.SERVICE_TOKEN = TOKEN;

const express = (await import('express')).default;
const { createAudioClips } = await import('../src/audio-clips.js');
const { createAudioStore } = await import('../src/audio.js');
const { openDatabase } = await import('../src/db/index.js');
const { registerAudioIngest } = await import('../src/routes/api-audio.js');

/** An ID3-tagged MP3 the store accepts, with ffmpeg stood in for. */
const FAKE_MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2000, 1)]);
const fakeTools = {
  run: async (_bin, args) => {
    await fs.writeFile(args[args.length - 1], FAKE_MP3);
    return { stdout: '' };
  },
  lengthOf: async () => 600,
};

let server;
let base;
let clips;
let root;

before(async () => {
  root = await fs.mkdtemp('/tmp/wasla-ingest-');
  const db = openDatabase(':memory:');
  clips = createAudioClips(db, { audio: createAudioStore(root, { maxBytes: 5_000_000 }), tools: fakeTools });
  const app = express();
  const router = express.Router();
  registerAudioIngest(router, { audioClips: clips });
  app.use('/api/v1', router);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});

after(() => server.close());

const post = (token, fields = {}) => {
  const body = new FormData();
  body.set('sound', new Blob([FAKE_MP3], { type: 'audio/mpeg' }), 'clip.mp3');
  body.set('title', 'صوت الرعد');
  body.set('seconds', '8');
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return fetch(`${base}/audio-clips`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
  });
};

test('a clip posted with the service token lands in the library', async () => {
  const answer = await post(TOKEN, { category: 'أصوات الطبيعة', licence: 'CC BY 3.0', author: 'Blender', source: 'https://youtu.be/x' });
  assert.equal(answer.status, 201);
  const { clip } = await answer.json();
  assert.deepEqual([clip.title, clip.category, clip.licence, clip.author], ['صوت الرعد', 'أصوات الطبيعة', 'CC BY 3.0', 'Blender']);
  assert.deepEqual(clips.list().map((c) => c.title), ['صوت الرعد']);
});

test('no token, a wrong one, or one of another length is refused', async () => {
  for (const bad of [undefined, '', 'nope', 'x'.repeat(64), `${TOKEN}x`]) {
    assert.equal((await post(bad)).status, 401, String(bad));
  }
  assert.equal(clips.list().length, 1, 'and nothing was stored by any of them');
});

test('a bad clip is refused with the reason, not stored', async () => {
  const answer = await post(TOKEN, { title: '  ' });
  assert.equal(answer.status, 400);
  assert.match((await answer.json()).error, /اسماً/);
  assert.equal(clips.list().length, 1);
});

test('without a service token the door is not there at all', async () => {
  const router = express.Router();
  const { config } = await import('../src/config.js');
  const real = config.serviceToken;
  config.serviceToken = '';
  registerAudioIngest(router, { audioClips: clips });
  config.serviceToken = real;
  assert.equal(router.stack.length, 0, 'no route was registered');
});
