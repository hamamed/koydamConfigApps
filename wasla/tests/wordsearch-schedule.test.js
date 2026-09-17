import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';

import { createAppConfig } from '../src/app-config.js';
import { dayToDate, parseDay } from '../src/daily.js';
import { openDatabase } from '../src/db/index.js';
import { createRepository } from '../src/repository.js';
import { createWordSearch, sizeForDay } from '../src/wordsearch-daily.js';
import { composeDay } from '../src/wordsearch-editor.js';
import { boardProblem, createWordSearchSchedule } from '../src/wordsearch-schedule.js';
import { cellsOf } from '../src/wordsearch.js';

const ANIMALS = ['أسد', 'نمر', 'فيل', 'زرافة', 'حصان', 'غزال', 'قرد', 'جمل'];
const FRUITS = ['تفاح', 'موز', 'عنب', 'برتقال', 'مشمش', 'رمان', 'كرز', 'ليمون'];
const COLOURS = ['احمر', 'ازرق', 'اخضر', 'اصفر', 'بنفسجي', 'برتقالي'];
const TODAY = '2026-09-17';

let db;
let repo;
let appConfig;
let wordSearch;
let days;

const add = (title, answers) => answers.map((answer) => repo.createQuestion({ title, answer, clue: 'x' }).question.id);
const plus = (date, n) => dayToDate(parseDay(date).day + n);

function customDay(date, seed = 7) {
  const words = COLOURS.map((word) => ({ id: null, word, display: word }));
  const { board } = composeDay({ theme: 'ألوان', words, size: 8, seed });
  return days.save(date, { theme: 'ألوان', size: 8, words, seed, board, source: 'custom' });
}

function assertValidBoard(board) {
  const grid = board.rows.map((r) => [...r]);
  assert.equal(grid.length, board.size);
  assert.ok(board.words.length >= 6 && board.words.length <= 10);
  for (const w of board.words) assert.equal(cellsOf(w).map(([r, c]) => grid[r][c]).join(''), w.word);
}

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = createRepository(db);
  appConfig = createAppConfig(db);
  wordSearch = createWordSearch(db, { appConfig });
  days = createWordSearchSchedule(db, { wordSearch, appConfig });
});

test('a stored board beats the automatic one, in the same shape, with coins from the current config', () => {
  add('حيوانات', ANIMALS);
  const automatic = days.boardFor('2026-09-18');
  assert.deepEqual(automatic, wordSearch.forDate('2026-09-18'));

  assert.deepEqual(customDay('2026-09-18'), {});
  const stored = days.boardFor('2026-09-18');
  assert.deepEqual(Object.keys(stored), Object.keys(automatic));
  assert.equal(stored.theme, 'ألوان');
  assert.equal(stored.size, 8);
  assertValidBoard(stored);
  assert.ok(stored.words.every((w) => Number.isInteger(w.id) && w.id >= 1_000_000_000));
  assert.deepEqual(days.get('2026-09-18').words.map((w) => w.id), COLOURS.map(() => null));

  appConfig.save({ ...appConfig.get(), dailyPuzzleCoins: 55 });
  assert.equal(days.boardFor('2026-09-18').coins, 55);
  assert.equal(days.boardFor('2026-02-30'), null);
});

test('editing or deleting questions never changes a stored board', () => {
  const ids = add('حيوانات', ANIMALS);
  add('فواكه', FRUITS);
  const { added } = days.addDays(7, TODAY);
  assert.equal(added.length, 7);
  const before = added.map((d) => days.boardFor(d.date));

  for (const id of ids) repo.deleteQuestion(id);
  add('حيوانات', ['دلفين', 'حوت', 'قرش', 'سلحفاة', 'فقمة', 'بطريق']);
  assert.deepEqual(added.map((d) => days.boardFor(d.date)), before);
});

test('adding days starts today, follows the weekday sizes and never repeats the day before’s theme', () => {
  add('حيوانات', ANIMALS);
  add('فواكه', FRUITS);
  add('ألوان', COLOURS);
  const result = days.addDays(14, TODAY);
  assert.equal(result.from, TODAY);
  assert.equal(result.to, plus(TODAY, 13));
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.added.map((d) => d.date), Array.from({ length: 14 }, (_, i) => plus(TODAY, i)));

  let previous = wordSearch.pickForDate(plus(TODAY, -1)).theme;
  for (const { date } of result.added) {
    const day = days.get(date);
    assert.equal(day.source, 'theme');
    assert.equal(day.size, sizeForDay(parseDay(date).day));
    assert.notEqual(day.theme, previous, `${date} repeats ${previous}`);
    assertValidBoard(day.board);
    assert.deepEqual(day.words.map((w) => w.id), day.board.words.map((w) => w.id));
    previous = day.theme;
  }
});

test('adding days continues after the last planned date, and ignores plans that are in the past', () => {
  add('حيوانات', ANIMALS);
  add('فواكه', FRUITS);
  customDay(plus(TODAY, -3));
  assert.equal(days.addDays(7, TODAY).from, TODAY);

  customDay(plus(TODAY, 10));
  const more = days.addDays(7, TODAY);
  assert.equal(more.from, plus(TODAY, 11));
  assert.equal(more.added.length, 7);
  // The day after a planned ألوان day takes a rotation theme, and the planned day is untouched.
  assert.equal(days.get(plus(TODAY, 10)).theme, 'ألوان');
  assert.equal(days.lastDate(), plus(TODAY, 17));
});

test('the first added day passes over the theme of the planned day before it', () => {
  add('حيوانات', ANIMALS);
  add('فواكه', FRUITS);
  const rotation = wordSearch.pickForDate(TODAY).theme;
  // Yesterday was planned by hand with the theme the rotation gives today.
  const words = COLOURS.map((word) => ({ id: null, word, display: word }));
  const { board } = composeDay({ theme: rotation, words, size: 8, seed: 1 });
  assert.deepEqual(days.save(plus(TODAY, -1), { theme: rotation, size: 8, words, seed: 1, board, source: 'custom' }), {});

  const { added } = days.addDays(7, TODAY);
  assert.equal(added[0].date, TODAY);
  assert.notEqual(added[0].theme, rotation);
});

test('a single theme is still used on consecutive days rather than leaving them empty', () => {
  add('حيوانات', ANIMALS);
  const { added, skipped } = days.addDays(7, TODAY);
  assert.equal(added.length, 7);
  assert.deepEqual(skipped, []);
  assert.ok(added.every((d) => d.theme === 'حيوانات'));
});

test('with no theme every day is skipped and nothing is stored', () => {
  add('حيوانات', ANIMALS.slice(0, 5));
  const result = days.addDays(7, TODAY);
  assert.deepEqual(result.added, []);
  assert.equal(result.skipped.length, 7);
  assert.equal(days.lastDate(), null);
  assert.ok(days.addDays(0, TODAY).error);
  assert.ok(days.addDays(61, TODAY).error);
});

test('deleting a day falls back to the automatic board', () => {
  add('حيوانات', ANIMALS);
  customDay('2026-09-18');
  assert.equal(days.remove('2026-09-18'), true);
  assert.equal(days.remove('2026-09-18'), false);
  assert.deepEqual(days.boardFor('2026-09-18'), wordSearch.forDate('2026-09-18'));
});

test('a board that does not match its letters, size or word rules is refused', () => {
  const words = COLOURS.map((word) => ({ id: null, word, display: word }));
  const { board } = composeDay({ theme: 'ألوان', words, size: 8, seed: 3 });
  assert.equal(boardProblem(board), null);
  const broken = { ...board, words: board.words.map((w, i) => (i === 0 ? { ...w, row: (w.row + 1) % 8 } : w)) };
  assert.match(boardProblem(broken) ?? '', /does not match/);
  assert.match(boardProblem({ ...board, words: board.words.slice(0, 5) }), /6 to 10/);
  assert.match(boardProblem({ ...board, words: board.words.map((w) => ({ ...w, id: 1 })) }), /own id/);
  assert.ok(days.save('2026-09-18', { theme: 'x', size: 8, words, seed: 3, board, source: 'custom' }).error);
  assert.ok(days.save('2026-02-30', { theme: 'ألوان', size: 8, words, seed: 3, board, source: 'custom' }).error);
  assert.ok(days.save('2026-09-18', { theme: 'ألوان', size: 8, words, seed: 3, board, source: 'other' }).error);
  assert.equal(days.get('2026-09-18'), null);
});

test('the summary counts days ahead, gaps and whether today is planned', () => {
  add('حيوانات', ANIMALS);
  assert.deepEqual(days.summary(TODAY), { lastDate: null, daysAhead: 0, low: true, todayScheduled: false, gaps: 0 });
  days.addDays(7, TODAY);
  assert.deepEqual(days.summary(TODAY), { lastDate: plus(TODAY, 6), daysAhead: 6, low: true, todayScheduled: true, gaps: 0 });
  customDay(plus(TODAY, 9));
  assert.deepEqual(days.summary(TODAY), { lastDate: plus(TODAY, 9), daysAhead: 9, low: false, todayScheduled: true, gaps: 2 });
  assert.deepEqual(days.fromDate(plus(TODAY, 5)).map((d) => d.date), [plus(TODAY, 5), plus(TODAY, 6), plus(TODAY, 9)]);
  assert.deepEqual(days.beforeDate(plus(TODAY, 2)).map((d) => d.date), [plus(TODAY, 1), TODAY]);
});

test('opening a database again keeps the planned days', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasla-days-'));
  const file = path.join(dir, 'wasla.db');
  try {
    const first = openDatabase(file);
    const firstConfig = createAppConfig(first);
    db = first;
    days = createWordSearchSchedule(first, { wordSearch: createWordSearch(first, { appConfig: firstConfig }), appConfig: firstConfig });
    assert.deepEqual(customDay('2026-09-18'), {});
    const saved = days.boardFor('2026-09-18');
    first.close();

    const again = openDatabase(file);
    const againConfig = createAppConfig(again);
    const reopened = createWordSearchSchedule(again, { wordSearch: createWordSearch(again, { appConfig: againConfig }), appConfig: againConfig });
    assert.deepEqual(reopened.boardFor('2026-09-18'), saved);
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
