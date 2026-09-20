import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import express from 'express';

import { createAppConfig } from '../src/app-config.js';
import { createDaily } from '../src/daily.js';
import { createDailyGames } from '../src/daily-games.js';
import { openDatabase } from '../src/db/index.js';
import { createEvents } from '../src/events.js';
import { createRepository } from '../src/repository.js';
import { apiRouter } from '../src/routes/api.js';
import { createWordSearch } from '../src/wordsearch-daily.js';
import { composeDay } from '../src/wordsearch-editor.js';
import { createWordSearchSchedule } from '../src/wordsearch-schedule.js';
import { cellsOf } from '../src/wordsearch.js';

let server;
let base;
let repo;
let db;
let level;
let wordSearchDays;

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

  const wordSearch = createWordSearch(db, { appConfig: createAppConfig(db) });
  wordSearchDays = createWordSearchSchedule(db, { wordSearch, appConfig: createAppConfig(db) });
  const app = express();
  app.use('/api/v1', apiRouter({
    repo,
    publicUrl: 'https://wasla.example',
    daily: createDaily(db, repo),
    appConfig: createAppConfig(db),
    events: createEvents(db, repo),
    wordSearch,
    wordSearchDays,
    dailyGames: createDailyGames(db, { appConfig: createAppConfig(db) }),
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
    timer: { secondsPerWord: 25, bonusCoins: 10 },
    reminderHour: 10,
    starsPerLevel: 2,
    streakFreezeCost: 50,
    wordSearchHelpCosts: { revealLetter: 15, revealWord: 40 },
    dailyGameCoins: 8,
    dailyAllGamesBonus: 30,
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

test('the word search is a 404 with a message until a title has six usable answers', async () => {
  // A Thursday with no seasonal event: a Friday would have its own theme.
  const res = await fetch(`${base}/wordsearch?date=2026-09-17`);
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /theme/);
});

test('the word search refuses a malformed date', async () => {
  for (const date of ['2026-02-30', '17-09-2026', 'today', '2026-09-17T10:00', '']) {
    const res = await fetch(`${base}/wordsearch?date=${encodeURIComponent(date)}`);
    assert.equal(res.status, 400, date);
    assert.match((await res.json()).error, /date/);
  }
});

test('the word search board has the contract shape, matches its rows and is the same for a date', async () => {
  for (const answer of ['أسد', 'نمر', 'فيل', 'زرافة', 'حصان', 'غزال', 'قرد', 'جمل']) {
    repo.createQuestion({ title: 'حيوانات', answer, clue: 'x' });
  }
  const res = await fetch(`${base}/wordsearch?date=2026-09-19`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
  const body = await res.json();

  assert.deepEqual(Object.keys(body).sort(), ['coins', 'date', 'rows', 'size', 'theme', 'words']);
  assert.deepEqual([body.date, body.theme, body.size, body.coins], ['2026-09-19', 'حيوانات', 9, 30]);
  assert.equal(body.rows.length, body.size);
  for (const row of body.rows) assert.equal([...row].length, body.size);
  assert.ok(body.words.length >= 6 && body.words.length <= 10);
  const grid = body.rows.map((r) => [...r]);
  for (const w of body.words) {
    assert.deepEqual(Object.keys(w).sort(), ['col', 'dCol', 'dRow', 'display', 'id', 'row', 'word']);
    assert.ok([-1, 0, 1].includes(w.dRow) && [-1, 0, 1].includes(w.dCol) && (w.dRow || w.dCol));
    assert.equal(cellsOf(w).map(([r, c]) => grid[r][c]).join(''), w.word);
  }
  const lion = body.words.find((w) => w.display === 'أسد');
  if (lion) assert.equal(lion.word, 'اسد');

  assert.deepEqual(await (await fetch(`${base}/wordsearch?date=2026-09-19`)).json(), body);
  const sunday = await (await fetch(`${base}/wordsearch?date=2026-09-20`)).json();
  assert.equal(sunday.size, 10);
});

test('a planned word search day is served as stored, in the same shape, and questions edits do not change it', async () => {
  // Runs after the board test above, so حيوانات is already a theme.
  const date = '2026-10-05';
  const automatic = await (await fetch(`${base}/wordsearch?date=${date}`)).json();

  const words = ['احمر', 'ازرق', 'اخضر', 'اصفر', 'بنفسجي', 'برتقالي'].map((word) => ({ id: null, word, display: word }));
  const { board, canSave } = composeDay({ theme: 'ألوان', words, size: 8, seed: 42 });
  assert.equal(canSave, true);
  assert.deepEqual(wordSearchDays.save(date, { theme: 'ألوان', size: 8, words, seed: 42, board, source: 'custom' }), {});

  const res = await fetch(`${base}/wordsearch?date=${date}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
  const stored = await res.json();
  assert.deepEqual(Object.keys(stored), Object.keys(automatic));
  assert.deepEqual(stored, { date, theme: 'ألوان', size: 8, coins: 30, rows: board.rows, words: board.words });
  stored.words.forEach((w) => {
    assert.deepEqual(Object.keys(w).sort(), ['col', 'dCol', 'dRow', 'display', 'id', 'row', 'word']);
    assert.ok(Number.isInteger(w.id) && w.id > 0);
  });

  // Editing questions changes nothing about a stored day.
  const extra = repo.createQuestion({ title: 'حيوانات', answer: 'دلفين', clue: 'x' }).question.id;
  assert.deepEqual(await (await fetch(`${base}/wordsearch?date=${date}`)).json(), stored);

  // Deleted, the date is automatic again.
  assert.equal(wordSearchDays.remove(date), true);
  const back = await (await fetch(`${base}/wordsearch?date=${date}`)).json();
  assert.equal(back.theme, 'حيوانات');
  repo.deleteQuestion(extra);
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

test('word search events are accepted for the daily puzzle only', async () => {
  const before = db.prepare("SELECT COUNT(*) FROM events WHERE type LIKE 'wordsearch_%'").pluck().get();
  const res = await post('/events', {
    device: '8a1f5b2e-3c4d-4e5f-9a0b-1c2d3e4f5a6b',
    events: [
      { type: 'wordsearch_started', level: 0, at: '2026-09-18T08:00:00Z' },
      { type: 'wordsearch_word_found', level: 0, word: 12, at: '2026-09-18T08:00:20Z' },
      { type: 'wordsearch_completed', level: 0, seconds: 140, stars: 3, at: '2026-09-18T08:02:20Z' },
      { type: 'wordsearch_completed', level: 2, seconds: 140, stars: 3 },
      { type: 'wordsearch_word_found', level: 0 },
    ],
  });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { accepted: 3 });
  assert.equal(db.prepare("SELECT COUNT(*) FROM events WHERE type LIKE 'wordsearch_%'").pluck().get(), before + 3);
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

test('daily games: one set per date with the reward numbers; wheel and guess from the built-in lists', async () => {
  const res = await fetch(`${base}/daily-games?date=2026-09-18`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /max-age=60/);
  assert.deepEqual([body.date, body.coins, body.allBonus], ['2026-09-18', 15, 50]);
  // Only two titles have questions here: never enough for four groups.
  assert.equal(body.groups, null);
  assert.equal(body.guess.tries, 6);
  assert.equal([...body.guess.word].length, 5);
  assert.ok(body.wheel.words.length >= 3);
  assert.deepEqual(await (await fetch(`${base}/daily-games?date=2026-09-18`)).json(), body);
});

test('daily games refuse a malformed date', async () => {
  const res = await fetch(`${base}/daily-games?date=2026-13-01`);
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error);
});
