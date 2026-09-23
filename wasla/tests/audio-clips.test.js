import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { beforeEach, test } from 'node:test';
import { promisify } from 'node:util';

import {
  clockText, createAudioClips, licenceClears, MAX_CATEGORY, MAX_SECONDS, readTime,
} from '../src/audio-clips.js';
import { createAudioStore } from '../src/audio.js';
import { openDatabase } from '../src/db/index.js';
import { createRepository } from '../src/repository.js';

const run = promisify(execFile);

/** An ID3-tagged MP3 the store will accept, without encoding anything. */
const FAKE_MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2000, 1)]);

let db;
let repo;
let clips;
let root;
let cuts;

/** ffmpeg and ffprobe stood in for, so the tests need neither. */
const fakeTools = () => ({
  run: async (_bin, args) => {
    cuts.push(args);
    await fs.writeFile(args[args.length - 1], FAKE_MP3);
    return { stdout: '' };
  },
  lengthOf: async () => 600,
});

beforeEach(async () => {
  db = openDatabase(':memory:');
  repo = createRepository(db);
  root = await fs.mkdtemp('/tmp/wasla-audio-');
  cuts = [];
  clips = createAudioClips(db, { audio: createAudioStore(root, { maxBytes: 5_000_000 }), tools: fakeTools() });
});

test('a time is read as seconds or as m:ss, and printed back as m:ss', () => {
  assert.deepEqual([readTime('0'), readTime('8'), readTime('1:05'), readTime('90')], [0, 8, 65, 90]);
  assert.deepEqual([readTime('abc'), readTime('1:2:3'), readTime('-4')], [null, null, null]);
  assert.deepEqual([clockText(0), clockText(8), clockText(65)], ['0:00', '0:08', '1:05']);
});

test('a clip is cut from the file at the asked place, and kept with its licence', async () => {
  const { clip, error } = await clips.save(FAKE_MP3, {
    title: 'صوت الرعد', category: 'أصوات الطبيعة', start: '1:05', seconds: '8',
    source: 'https://freesound.org/s/1', licence: 'CC0', author: 'someone',
  });
  assert.equal(error, undefined);
  assert.deepEqual([clip.title, clip.category, clip.licence, clip.author, clip.source],
    ['صوت الرعد', 'أصوات الطبيعة', 'CC0', 'someone', 'https://freesound.org/s/1']);
  // ffmpeg was asked for exactly that piece.
  assert.equal(cuts[0][cuts[0].indexOf('-ss') + 1], '65');
  assert.equal(cuts[0][cuts[0].indexOf('-t') + 1], '8');
  assert.match(clip.file, /^[a-f0-9]{24}\.mp3$/);
  assert.deepEqual(await fs.readFile(`${root}/${clip.file}`), FAKE_MP3);
  assert.deepEqual(clips.list().map((c) => [c.title, c.used]), [['صوت الرعد', 0]]);
});

test('a clip needs a name, a sound, and a length the app can play', async () => {
  const ok = { title: 'صوت', start: '0', seconds: '8' };
  assert.match((await clips.save(FAKE_MP3, { ...ok, title: '  ' })).error, /اسماً/);
  assert.match((await clips.save(Buffer.alloc(40), ok)).error, /MP3/);
  assert.match((await clips.save(FAKE_MP3, { ...ok, start: 'later' })).error, /بداية/);
  assert.match((await clips.save(FAKE_MP3, { ...ok, seconds: '0' })).error, /مدة/);
  assert.match((await clips.save(FAKE_MP3, { ...ok, seconds: String(MAX_SECONDS + 1) })).error, /مدة/);
  // A start past the end of the file is a cut of nothing.
  assert.match((await clips.save(FAKE_MP3, { ...ok, start: '15:00' })).error, /بعد نهاية/);
  assert.deepEqual(clips.list(), [], 'and nothing was stored along the way');
});

test('without ffmpeg the upload is refused rather than stored whole', async () => {
  const broken = createAudioClips(db, {
    audio: createAudioStore(root, { maxBytes: 5_000_000 }),
    tools: { run: async () => { throw new Error('ENOENT'); }, lengthOf: async () => 60 },
  });
  const { error } = await broken.save(FAKE_MP3, { title: 'صوت', start: '0', seconds: '8' });
  assert.match(error, /ffmpeg/);
  assert.deepEqual(broken.list(), []);
});

test('a clip a question plays keeps its file when it leaves the library', async () => {
  const kept = (await clips.save(FAKE_MP3, { title: 'مستعمل', start: '0', seconds: '5' })).clip;
  const loose = (await clips.save(FAKE_MP3, { title: 'حرّ', start: '0', seconds: '5' })).clip;
  repo.createQuestion({ answer: 'رعد', clue: 'ما هذا الصوت؟', title: 'أصوات', type: 'audio', audioFile: kept.file });
  assert.equal(clips.list().find((c) => c.id === kept.id).used, 1);

  await clips.remove(kept.id, { inUse: (file) => repo.mediaInUse(file) });
  await clips.remove(loose.id, { inUse: (file) => repo.mediaInUse(file) });
  assert.deepEqual(clips.list(), [], 'both left the library');
  assert.ok(await fs.stat(`${root}/${kept.file}`), 'the question still has its sound');
  await assert.rejects(fs.stat(`${root}/${loose.file}`), 'the unused one is gone from disk');
  assert.match((await clips.remove(kept.id, { inUse: () => false })).error, /لا مقطع/);
});

test('clips are kept in categories, counted and filtered by them', async () => {
  const put = (title, category) => clips.save(FAKE_MP3, { title, category, start: '0', seconds: '5' });
  await put('رعد', 'أصوات الطبيعة');
  await put('مطر', ' أصوات   الطبيعة ');     // spaces squeezed, so it lands in the same one
  await put('عود', 'آلات موسيقية');
  await put('مجهول', '   ');                  // nothing but spaces is no category at all

  assert.deepEqual(clips.categories().map((g) => [g.name, g.total]),
    [['آلات موسيقية', 1], ['أصوات الطبيعة', 2], ['', 1]], 'the uncategorised come last');
  assert.deepEqual(clips.list({ category: 'أصوات الطبيعة' }).map((c) => c.title), ['مطر', 'رعد']);
  assert.deepEqual(clips.list({ category: '' }).map((c) => c.title), ['مجهول'], 'the empty name is those with none');
  assert.equal(clips.list().length, 4, 'and no filter is the whole library');

  const long = (await put('طويل', 'ف'.repeat(MAX_CATEGORY + 20))).clip;
  assert.equal([...long.category].length, MAX_CATEGORY);
});

test('a clip moves to another category without being uploaded again', async () => {
  const { clip } = await clips.save(FAKE_MP3, { title: 'عود', category: 'أصوات الطبيعة', start: '0', seconds: '5' });
  const { clip: moved } = clips.update(clip.id, { title: clip.title, category: 'آلات موسيقية' });
  assert.deepEqual([moved.category, moved.file], ['آلات موسيقية', clip.file], 'same file, new category');
  assert.equal(clips.update(clip.id, { title: clip.title, category: '' }).clip.category, null);
});

test('a licence that already permits publishing clears a clip on the way in', () => {
  for (const yes of ['CC0', 'cc0 1.0', 'CC BY 4.0', 'CC BY-SA 4.0', 'Public Domain', 'مِلكنا']) {
    assert.equal(licenceClears(yes), true, yes);
  }
  for (const no of ['', '   ', 'Standard YouTube License', 'رخصة يوتيوب القياسية', 'All rights reserved']) {
    assert.equal(licenceClears(no), false, no);
  }
});

test('a clip nobody permitted is held back, and no sound is served for it', async () => {
  const held = (await clips.save(FAKE_MP3, { title: 'محجوز', start: '0', seconds: '5' })).clip;
  const free = (await clips.save(FAKE_MP3, { title: 'حر', start: '0', seconds: '5', licence: 'CC0' })).clip;
  assert.deepEqual([held.cleared, free.cleared], [0, 1], 'the licence decides it, not the upload');
  assert.equal(clips.isPublishable(held.file), false);
  assert.equal(clips.isPublishable(free.file), true);
  // A file no clip owns is an older upload, and is served as it always was.
  assert.equal(clips.isPublishable('deadbeefdeadbeefdeadbeef.mp3'), true);

  const now = clips.setCleared(held.id, true, 'إذن بالبريد من القناة 2026-09-23').clip;
  assert.deepEqual([now.cleared, now.cleared_note], [1, 'إذن بالبريد من القناة 2026-09-23']);
  assert.equal(clips.isPublishable(held.file), true);

  // And permission can be taken back.
  assert.equal(clips.setCleared(held.id, false).clip.cleared, 0);
  assert.equal(clips.isPublishable(held.file), false);
  assert.match(clips.setCleared(999, true).error, /لا مقطع/);
});

test('a clip told outright that it is cleared overrides what its licence says', async () => {
  const { clip } = await clips.save(FAKE_MP3, {
    title: 'بإذن', start: '0', seconds: '5', licence: 'Standard YouTube License', cleared: true,
  });
  assert.equal(clip.cleared, 1);
});

test('a clip can be renamed and re-credited', async () => {
  const { clip } = await clips.save(FAKE_MP3, { title: 'قديم', start: '0', seconds: '5' });
  const { clip: now } = clips.update(clip.id, { title: 'جديد', licence: 'CC BY 4.0', author: 'x', source: '' });
  assert.deepEqual([now.title, now.licence, now.source], ['جديد', 'CC BY 4.0', null]);
  assert.match(clips.update(clip.id, { title: '' }).error, /اسماً/);
  assert.match(clips.update(999, { title: 'x' }).error, /لا مقطع/);
});

test('ffmpeg really cuts the piece asked for', { skip: !(await run('ffmpeg', ['-version']).then(() => true, () => false)) }, async () => {
  const source = `${root}/tone.mp3`;
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20', '-b:a', '128k', source]);
  const real = createAudioClips(db, { audio: createAudioStore(root, { maxBytes: 5_000_000 }) });
  const { clip, error } = await real.save(await fs.readFile(source), { title: 'نغمة', start: '0:05', seconds: '3' });
  assert.equal(error, undefined);
  assert.ok(Math.abs(clip.seconds - 3) <= 1, `the stored clip is about three seconds, not ${clip.seconds}`);
});
