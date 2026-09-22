import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';

import { createAppConfig } from '../src/app-config.js';
import { openDatabase } from '../src/db/index.js';
import { parseDay } from '../src/daily.js';
import { createRepository } from '../src/repository.js';
import { createWordSearch, sizeForDay, themeWords } from '../src/wordsearch-daily.js';
import { cellsOf } from '../src/wordsearch.js';

const ANIMALS = ['أسد', 'نمر', 'فيل', 'زرافة', 'حصان', 'غزال', 'قرد', 'جمل'];
const FRUITS = ['تفاح', 'موز', 'عنب', 'برتقال', 'مشمش', 'رمان', 'كرز', 'ليمون'];

let db;
let repo;
let wordSearch;

const add = (title, answers) => answers.map((answer) => repo.createQuestion({ title, answer, clue: 'x' }).question.id);

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = createRepository(db);
  wordSearch = createWordSearch(db, { appConfig: createAppConfig(db) });
});

test('a theme keeps played answers of 3–8 letters, once each, and drops words hidden in others', () => {
  const questions = [
    { id: 1, answer: 'أسد' },
    { id: 2, answer: 'اسد' }, // the same word once folded
    { id: 3, answer: 'دب' }, // too short
    { id: 4, answer: 'فرسالنهر' }, // 8 letters: kept
    { id: 5, answer: 'البرتقالة' }, // 9 letters
    { id: 6, answer: 'نمر' },
    { id: 7, answer: 'نمرة' }, // نمر is inside it
    { id: 8, answer: 'رمن' }, // reads as نمر backwards, which is inside نمرة
  ];
  const { words, skipped } = themeWords(questions);
  assert.deepEqual(words.map((w) => [w.id, w.word, w.display]), [[1, 'اسد', 'أسد'], [4, 'فرسالنهر', 'فرسالنهر'], [7, 'نمرة', 'نمرة']]);
  assert.deepEqual(skipped.map((s) => [s.id, s.reason]), [[2, 'duplicate'], [3, 'length'], [5, 'length'], [6, 'contained'], [8, 'contained']]);
});

test('titles are grouped trimmed; six usable words make a theme, and the rest say how many are missing', () => {
  add('حيوانات', ANIMALS.slice(0, 4));
  add(' حيوانات ', ANIMALS.slice(4, 6));
  add('فواكه', FRUITS.slice(0, 5));
  const themes = wordSearch.themes();
  assert.deepEqual(themes.map((t) => [t.title, t.words.length, t.eligible, t.missing]), [['حيوانات', 6, true, 0], ['فواكه', 5, false, 1]]);
});

test('an excluded theme is kept out, and can be let back in', () => {
  add('حيوانات', ANIMALS);
  add('فواكه', FRUITS);
  assert.equal(wordSearch.playable().length, 2);
  assert.deepEqual(wordSearch.setExcluded(' فواكه ', true), {});
  wordSearch.setExcluded('فواكه', true); // twice is harmless
  assert.deepEqual(wordSearch.playable().map((t) => t.title), ['حيوانات']);
  assert.equal(wordSearch.themes().find((t) => t.title === 'فواكه').excluded, true);
  wordSearch.setExcluded('فواكه', false);
  assert.equal(wordSearch.playable().length, 2);
  assert.ok(wordSearch.setExcluded('  ', true).error);
});

test('the size rises through the week, and its own days take the whole board', () => {
  // 2026-09-14 is a Monday; the week gives the word search Thursday and Sunday.
  const sizes = Array.from({ length: 7 }, (_, i) => sizeForDay(parseDay('2026-09-14').day + i));
  assert.deepEqual(sizes, [9, 9, 10, 10, 10, 10, 10]);
});

test('a date gets a deterministic board from its theme, matching the contract', () => {
  add('حيوانات', ANIMALS);
  add('فواكه', FRUITS);
  const board = wordSearch.forDate('2026-09-17'); // a Thursday: the word search's own day, so the whole board
  assert.deepEqual(Object.keys(board).sort(), ['coins', 'date', 'rows', 'size', 'theme', 'words']);
  assert.equal(board.date, '2026-09-17');
  assert.equal(board.size, 10);
  assert.equal(board.coins, 30);
  assert.ok(['حيوانات', 'فواكه'].includes(board.theme));
  assert.ok(board.words.length >= 6 && board.words.length <= 12);
  const grid = board.rows.map((r) => [...r]);
  assert.equal(grid.length, 10);
  for (const w of board.words) {
    assert.equal(cellsOf(w).map(([r, c]) => grid[r][c]).join(''), w.word);
    assert.ok([...w.word].length >= 3 && [...w.word].length <= 8);
  }
  assert.deepEqual(wordSearch.forDate('2026-09-17'), board);

  // Consecutive days rotate through the themes.
  assert.notEqual(wordSearch.forDate('2026-09-20').theme, board.theme);
});

test('a theme with too few words that fit the day passes the day to one that has them', () => {
  // A board of nine wants eleven words; a theme with six cannot fill one.
  add('قليلة', ['برتقالية', 'فراولتان', 'مانجوتان', 'اناناسات', 'جوافتين', 'مشمشتين']);
  add('كثيرة', [...ANIMALS, 'دلفين', 'حوت', 'قرش', 'سلحفاة', 'فقمة', 'بطريق']);
  const board = wordSearch.forDate('2026-09-14');
  assert.equal(board.theme, 'كثيرة');
  assert.ok(board.words.length >= 11, `${board.words.length} words on a ${board.size} board`);
});

test('no board without a theme, or for a date that is not a date', () => {
  add('حيوانات', ANIMALS.slice(0, 5));
  assert.equal(wordSearch.forDate('2026-09-19'), null);
  add('حيوانات', ANIMALS.slice(5));
  assert.ok(wordSearch.forDate('2026-09-19'));
  assert.equal(wordSearch.forDate('2026-02-30'), null);
  wordSearch.setExcluded('حيوانات', true);
  assert.equal(wordSearch.forDate('2026-09-19'), null);
});

test('coins follow the daily puzzle coins in the config', () => {
  add('حيوانات', ANIMALS);
  const appConfig = createAppConfig(db);
  appConfig.save({ ...appConfig.get(), dailyPuzzleCoins: 45 });
  assert.equal(wordSearch.forDate('2026-09-18').coins, 45);
});

test('opening a database again keeps the exclusion table and its rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasla-ws-'));
  const file = path.join(dir, 'wasla.db');
  try {
    const first = openDatabase(file);
    createWordSearch(first, { appConfig: createAppConfig(first) }).setExcluded('حيوانات', true);
    first.close();
    const again = openDatabase(file);
    assert.deepEqual(again.prepare('SELECT title FROM wordsearch_excluded_titles').pluck().all(), ['حيوانات']);
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
