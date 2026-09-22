import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { letters } from '../src/arabic.js';
import {
  buildConnect, buildProverbConnect, CONNECT_MIN_WORDS, CONNECT_SIZE, CONNECT_WORDS, connectForDate,
  connectPool, plant,
} from '../src/connect.js';
import { createAppConfig } from '../src/app-config.js';
import { createDailyGames } from '../src/daily-games.js';
import { openDatabase } from '../src/db/index.js';
import { createRepository } from '../src/repository.js';

const SCHOOL = ['مدرسة', 'قلم', 'كتاب', 'معلم', 'دفتر', 'حصة', 'طالب', 'مقعد', 'سبورة', 'درس', 'جرس', 'ملعب'];

const pool = (words, title = 'مدرسة') => words.map((word, index) => ({
  id: index + 1, word, display: word, clue: `دليل ${word}`, title,
}));

/** True when the path never jumps: every step touches the one before it. */
const touching = (path) => path.every(([r, c], index) => {
  if (index === 0) return true;
  const [pr, pc] = path[index - 1];
  return Math.abs(r - pr) <= 1 && Math.abs(c - pc) <= 1 && !(r === pr && c === pc);
});

let db;
let repo;

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = createRepository(db);
  SCHOOL.forEach((answer) => repo.createQuestion({ title: 'مدرسة', answer, clue: `دليل ${answer}` }));
});

test('a planted word lies along touching cells, and spells itself', () => {
  const grid = Array.from({ length: 4 }, () => Array(4).fill(null));
  const path = plant(grid, 'مدرسة', () => 0.42);
  assert.ok(path, 'مدرسة fits a 4×4 board');
  assert.equal(path.length, 5);
  assert.ok(touching(path));
  assert.equal(path.map(([r, c]) => grid[r][c]).join(''), 'مدرسة');
  assert.equal(new Set(path.map(String)).size, path.length, 'never the same cell twice');
});

test('a word longer than the board is refused, and the board is left alone', () => {
  const grid = [[null, null], [null, null]];
  assert.equal(plant(grid, 'مستشفيات', () => 0.5), null);
  assert.deepEqual(grid, [[null, null], [null, null]], 'nothing was written');
});

test('a board carries its words, each findable on it', () => {
  const board = buildConnect(pool(SCHOOL), 99);
  assert.equal(board.size, CONNECT_SIZE);
  assert.equal(board.rows.length, CONNECT_SIZE);
  for (const row of board.rows) assert.equal(letters(row).length, CONNECT_SIZE);
  assert.equal(board.words.length, CONNECT_WORDS);

  const grid = board.rows.map((row) => letters(row));
  for (const word of board.words) {
    assert.ok(touching(word.path), `${word.display} is one drag`);
    assert.equal(word.path.map(([r, c]) => grid[r][c]).join(''), word.word, `${word.display} is on the board`);
  }
  assert.deepEqual(buildConnect(pool(SCHOOL), 99), board, 'the same seed gives the same board');
});

test('every cell is a letter, and the words come shortest first', () => {
  const board = buildConnect(pool(SCHOOL), 7);
  assert.ok(board.rows.every((row) => letters(row).every((letter) => /^[ء-غف-ي]$/u.test(letter))));
  const lengths = board.words.map((w) => letters(w.word).length);
  assert.deepEqual(lengths, [...lengths].sort((a, b) => a - b));
});

test('too few words to plant is no board at all', () => {
  assert.equal(buildConnect(pool(['قلم', 'درس']), 1), null);
  assert.equal(buildConnect([], 1), null);
  assert.ok(buildConnect(pool(SCHOOL.slice(0, CONNECT_MIN_WORDS)), 3), 'four is enough');
});

test('a board from the bank carries each word\'s question, and a proverb board none', () => {
  const board = buildConnect(pool(SCHOOL), 21);
  assert.ok(board.words.every((word) => word.clue), 'the question comes with the word');

  const proverb = buildProverbConnect(PROVERB, 21);
  assert.ok(proverb.words.every((word) => word.clue === ''), 'a proverb\'s words have no question');
});

test('the pool is every answer once, in its played form', () => {
  const rows = db.prepare("SELECT id, answer, IFNULL(clue, '') AS clue, title FROM questions ORDER BY id").all();
  const list = connectPool([...rows, ...rows]);
  assert.ok(list.every((entry) => entry.clue), 'the clue travels with it');
  assert.equal(list.length, SCHOOL.length, 'the same answer is not offered twice');
  assert.ok(list.every((entry) => entry.word && entry.display));
});

test('a date always gets the same board, and its words share a title when one is deep enough', () => {
  const rows = db.prepare('SELECT id, answer, trim(IFNULL(title, \'\')) AS title FROM questions ORDER BY id').all();
  const first = connectForDate(rows, '2026-09-23');
  assert.deepEqual(connectForDate(rows, '2026-09-23'), first);
  assert.equal(first.theme, 'مدرسة', '12 words is deep enough for a board of its own');
  assert.notDeepEqual(connectForDate(rows, '2026-09-23', { nonce: 1 }), first);
  assert.equal(connectForDate(rows, 'nonsense'), null);
  assert.equal(connectForDate([], '2026-09-23'), null);
});

test('the day the week gives it sends a board, and the marathon a shorter one', () => {
  const games = createDailyGames(db, { appConfig: createAppConfig(db) });
  const set = games.forDate('2026-09-23');
  assert.equal(set.kind, 'connect');
  assert.equal(set.connect.words.length, CONNECT_WORDS);
  const run = games.marathonFor('2026-09-25');
  const round = run.rounds.find((r) => r.kind === 'connect');
  assert.ok(round, 'the run includes it');
  assert.ok(round.game.words.length < CONNECT_WORDS, 'a sprint asks for fewer');
});


const PROVERB = {
  before: 'أطلب العلم ولو في',
  after: '',
  answer: 'الصين',
  source: 'مثل سائر',
  emoji: '😑📚🤲',
};

test('a proverb board plants the proverb\'s own words, and keeps its clue', () => {
  const board = buildProverbConnect(PROVERB, 11);
  assert.equal(board.phrase, 'أطلب العلم ولو في الصين');
  assert.equal(board.emoji, '😑📚🤲');
  assert.equal(board.theme, 'مثل سائر');
  const found = board.words.map((w) => w.display).sort();
  assert.deepEqual(found, ['أطلب', 'العلم', 'ولو', 'الصين'].sort(), '«في» alone is too short to drag');

  const grid = board.rows.map((row) => letters(row));
  for (const word of board.words) {
    assert.ok(touching(word.path));
    assert.equal(word.path.map(([r, c]) => grid[r][c]).join(''), word.word);
  }
});

test('a board of plain words carries no clue, and a proverb one needs a proverb', () => {
  const plain = buildConnect(pool(SCHOOL), 5);
  assert.equal(plain.emoji, undefined, 'only the picker adds the empty fields');
  assert.equal(buildProverbConnect(null, 1), null);
  assert.equal(buildProverbConnect({ before: 'في', after: '', answer: 'و' }, 1), null, 'nothing long enough to plant');
});

test('the week alternates between a proverb and the bank', () => {
  const rows = db.prepare('SELECT id, answer, trim(IFNULL(title, \'\')) AS title FROM questions ORDER BY id').all();
  const riddles = [PROVERB];
  const flavours = new Set();
  for (let i = 0; i < 28; i += 7) {
    const board = connectForDate(rows, `2026-09-${String(1 + i).padStart(2, '0')}`, { riddles });
    flavours.add(board.phrase ? 'مثل' : 'بنك');
  }
  assert.deepEqual([...flavours].sort(), ['بنك', 'مثل'], 'both turn up over four weeks');

  // With no proverbs at all it is always the bank, and never empty.
  const board = connectForDate(rows, '2026-09-23', { riddles: [] });
  assert.equal(board.phrase, '');
  assert.ok(board.words.length >= CONNECT_MIN_WORDS);
});
