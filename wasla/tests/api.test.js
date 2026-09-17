import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import express from 'express';

import { createAppConfig } from '../src/app-config.js';
import { createDaily } from '../src/daily.js';
import { openDatabase } from '../src/db/index.js';
import { createEvents } from '../src/events.js';
import { createRepository } from '../src/repository.js';
import { apiRouter } from '../src/routes/api.js';

let server;
let base;
let repo;
let db;
let level;

before(async () => {
  db = openDatabase(':memory:');
  repo = createRepository(db);
  const ids = [
    repo.createQuestion({ title: 'بلدان', answer: 'المغرب', clue: 'بلد عاصمته الرباط', imageFile: 'aaaaaaaaaaaaaaaaaaaaaaaa.jpg', zoom: 2, focusX: 0.25, focusY: 0.75, blurred: true }),
    repo.createQuestion({ title: 'عام', answer: 'مصر', clue: 'بلد الأهرامات', emoji: '🇪🇬🐪' }),
    repo.createQuestion({ title: 'عام', answer: 'باريس', clue: 'عاصمة فرنسا', audioFile: 'bbbbbbbbbbbbbbbbbbbbbbbb.m4a' }),
    repo.createQuestion({ title: 'عام', answer: 'أسد', clue: 'ملك الغابة' }),
  ].map((r) => r.question.id);
  level = repo.createLevel({ difficulty: 'easy' });
  repo.setLevelQuestions(level.id, ids);
  assert.equal(repo.setPublished(level.id, true).error, undefined);
  repo.createLevel();

  const app = express();
  app.use('/api/v1', apiRouter({
    repo,
    publicUrl: 'https://wasla.example',
    daily: createDaily(db, repo),
    appConfig: createAppConfig(db),
    events: createEvents(db, repo),
  }));
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});

after(() => server.close());

const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('lists published levels only', async () => {
  const res = await fetch(`${base}/levels`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body.levels.map((l) => [l.number, l.title, l.wordCount]), [[1, 'لغز رقم 1', 4]]);
});

test('level summaries carry difficulty and no pack fields', async () => {
  const all = await (await fetch(`${base}/levels`)).json();
  assert.deepEqual(Object.keys(all.levels[0]).sort(), ['cols', 'difficulty', 'number', 'rows', 'title', 'updatedAt', 'wordCount']);
  assert.equal(all.levels[0].difficulty, 'easy');

  // A leftover ?pack= from an old app is ignored: the same single run comes back.
  const filtered = await (await fetch(`${base}/levels?pack=countries`)).json();
  assert.deepEqual(filtered, all);
});

test('a level carries its grid, clues and image framing', async () => {
  const body = await (await fetch(`${base}/levels/1`)).json();

  assert.equal(body.number, 1);
  assert.equal(body.difficulty, 'easy');
  assert.equal('pack' in body, false);
  assert.equal('packPosition' in body, false);
  assert.ok(body.rows > 0 && body.cols > 0);
  const morocco = body.words.find((w) => w.answer === 'المغرب');
  assert.deepEqual(morocco.image, {
    url: 'https://wasla.example/media/questions/aaaaaaaaaaaaaaaaaaaaaaaa.jpg',
    zoom: 2, focusX: 0.25, focusY: 0.75, blurred: true,
  });
  assert.equal(morocco.type, 'image');
  const egypt = body.words.find((w) => w.answer === 'مصر');
  assert.equal(egypt.image, null);
  assert.ok(['across', 'down'].includes(egypt.direction));
  assert.equal(typeof egypt.row, 'number');
});

test('a word has the contract shape: played answer, spelling, type, emoji and audio', async () => {
  const { words } = await (await fetch(`${base}/levels/1`)).json();
  const keys = ['id', 'answer', 'answerDisplay', 'title', 'clue', 'row', 'col', 'direction', 'type', 'image', 'emoji', 'audio'];
  words.forEach((w) => assert.deepEqual(Object.keys(w).sort(), [...keys].sort()));

  const lion = words.find((w) => w.answerDisplay === 'أسد');
  assert.deepEqual([lion.answer, lion.type, lion.emoji, lion.audio, lion.image], ['اسد', 'text', null, null, null]);

  const egypt = words.find((w) => w.answer === 'مصر');
  assert.deepEqual([egypt.type, egypt.emoji, egypt.audio], ['emoji', '🇪🇬🐪', null]);

  const paris = words.find((w) => w.answer === 'باريس');
  assert.equal(paris.type, 'audio');
  assert.deepEqual(paris.audio, { url: 'https://wasla.example/media/audio/bbbbbbbbbbbbbbbbbbbbbbbb.m4a' });
  assert.equal(paris.emoji, null);
});

test('every word carries its title, and no category', async () => {
  const { words } = await (await fetch(`${base}/levels/1`)).json();

  assert.equal(words.find((w) => w.answer === 'المغرب').title, 'بلدان');
  assert.equal(words.find((w) => w.answer === 'مصر').title, 'عام');
  words.forEach((w) => assert.equal('category' in w, false));
});

test('a question from before titles is sent with an empty title', async () => {
  const untitled = db.prepare("SELECT id FROM questions WHERE answer = 'باريس'").get().id;
  db.prepare('UPDATE questions SET title = NULL WHERE id = ?').run(untitled);
  try {
    const { words } = await (await fetch(`${base}/levels/1`)).json();
    assert.equal(words.find((w) => w.id === untitled).title, '');
  } finally {
    db.prepare("UPDATE questions SET title = 'عام' WHERE id = ?").run(untitled);
  }
});

test('an unknown or unpublished level is a 404 with a message', async () => {
  for (const path of ['/levels/2', '/levels/abc']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 404);
    assert.ok((await res.json()).error);
  }
});

test('there is no packs endpoint', async () => {
  const res = await fetch(`${base}/packs`);
  assert.equal(res.status, 404);
});

test('config returns the contract defaults', async () => {
  const body = await (await fetch(`${base}/config`)).json();
  assert.deepEqual(body, {
    dailyRewards: [10, 15, 20, 25, 30, 40, 60],
    dailyPuzzleCoins: 30,
    streakBonusPerDay: 5,
    streakBonusMax: 50,
    timer: { secondsPerWord: 25, bonusCoins: 15 },
    reminderHour: 10,
  });
});

test('the daily puzzle is a level with number 0, its date and its coins', async () => {
  const res = await fetch(`${base}/daily?date=2026-09-17`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual([body.number, body.date, body.coins, body.title], [0, '2026-09-17', 30, 'لغز اليوم']);
  assert.equal(body.words.length, 4);
  assert.ok(body.words[0].answerDisplay);
});

test('the daily puzzle refuses a malformed date', async () => {
  for (const date of ['2026-02-30', '17-09-2026', 'today', '2026-09-17T10:00']) {
    const res = await fetch(`${base}/daily?date=${encodeURIComponent(date)}`);
    assert.equal(res.status, 400, date);
    assert.match((await res.json()).error, /date/);
  }
});

test('events are accepted with 202 and a count, unknown types ignored', async () => {
  const res = await post('/events', {
    device: '8a1f5b2e-3c4d-4e5f-9a0b-1c2d3e4f5a6b',
    events: [
      { type: 'question_opened', level: 1, word: 1, at: '2026-09-17T10:00:00Z' },
      { type: 'question_solved', level: 1, word: 1, seconds: 14, at: '2026-09-17T10:00:14Z' },
      { type: 'help_used', level: 1, word: 1, help: 'revealLetter', at: '2026-09-17T10:00:05Z' },
      { type: 'question_left', level: 1, word: 2, at: '2026-09-17T10:01:00Z' },
      { type: 'level_completed', level: 0, seconds: 95, stars: 2, at: '2026-09-17T10:02:00Z' },
      { type: 'something_new', level: 1 },
    ],
  });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { accepted: 5 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 5);
});

test('events refuse a bad batch, a body over 64 kB and malformed JSON', async () => {
  const noDevice = await post('/events', { events: [] });
  assert.equal(noDevice.status, 400);
  assert.ok((await noDevice.json()).error);

  const big = await post('/events', { device: '8a1f5b2e-3c4d-4e5f-9a0b-1c2d3e4f5a6b', events: [], pad: 'x'.repeat(70 * 1024) });
  assert.equal(big.status, 413);
  assert.ok((await big.json()).error);

  const broken = await post('/events', '{"device":');
  assert.equal(broken.status, 400);
  assert.ok((await broken.json()).error);
});
