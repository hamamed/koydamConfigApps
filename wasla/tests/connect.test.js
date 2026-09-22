import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { createAppConfig } from '../src/app-config.js';
import { foldForPlay, letters } from '../src/arabic.js';
import {
  boardShape, buildConnect, CONNECT_LETTERS, CONNECT_SIDES, connectForDate, connectPool, snake,
} from '../src/connect.js';
import { createDailyGames } from '../src/daily-games.js';
import { openDatabase } from '../src/db/index.js';
import { random } from '../src/wordsearch.js';
import { createRepository } from '../src/repository.js';

const BANK = [
  ['أكبر مدن المغرب', 'الدار البيضاء'],   // 12 → 3×4
  ['عاصمة مصر', 'القاهرة'],               // 7  → no board
  ['أطول نهر في العالم', 'النيل'],        // 4  → too short
  ['بلد الأهرامات', 'جمهورية مصر'],       // 10 → 2×5
  ['أداة للكتابة', 'قلم'],                // 3  → too short
  ['مدينة مغربية', 'مراكش'],              // 5  → too short
  ['أكبر قارة', 'قارة آسيا'],             // 8  → 2×4
  ['', 'مدينة نيويورك'],                  // 12, but nothing to read
];

/** True when every step of the path touches the one before it. */
const touching = (path) => path.every(([r, c], index) => {
  if (index === 0) return true;
  const [pr, pc] = path[index - 1];
  return Math.abs(r - pr) <= 1 && Math.abs(c - pc) <= 1 && !(r === pr && c === pc);
});

let db;
let rows;

beforeEach(() => {
  db = openDatabase(':memory:');
  const repo = createRepository(db);
  BANK.forEach(([clue, answer]) => repo.createQuestion({ title: 'عام', answer, clue }));
  rows = db.prepare("SELECT id, answer, IFNULL(clue, '') AS clue, trim(IFNULL(title, '')) AS title FROM questions ORDER BY id").all();
});

test('the board is the pair of sides closest to a square, or no board at all', () => {
  assert.deepEqual(boardShape(12), { rows: 3, cols: 4 });
  assert.deepEqual(boardShape(16), { rows: 4, cols: 4 });
  assert.deepEqual(boardShape(9), { rows: 3, cols: 3 });
  assert.deepEqual(boardShape(10), { rows: 2, cols: 5 });
  assert.equal(boardShape(11), null, '11 is prime');
  assert.equal(boardShape(14), null, `14 would need a side over ${CONNECT_SIDES[1]}`);
  assert.deepEqual(boardShape(4), { rows: 2, cols: 2 }, 'the shape exists, even where the game refuses the length');
});

test('the snake visits every box once, each step touching the last', () => {
  for (const [rowCount, colCount] of [[3, 4], [4, 4], [2, 5], [3, 3]]) {
    const path = snake(rowCount, colCount, random(7));
    assert.ok(path, `${rowCount}×${colCount} has a path`);
    assert.equal(path.length, rowCount * colCount, 'every box');
    assert.equal(new Set(path.map(String)).size, path.length, 'each box once');
    assert.ok(touching(path));
  }
});

test('the answer fills every box, read along the path', () => {
  const board = buildConnect({ id: 1, answer: 'الدار البيضاء', clue: 'أكبر مدن المغرب', title: 'مدن' }, 42);
  assert.equal(board.display, 'الدار البيضاء');
  assert.equal(board.answer, foldForPlay('الدار البيضاء'));
  assert.equal(board.rows.length, 3);
  assert.equal(board.cols, 4);
  for (const row of board.rows) assert.equal(letters(row).length, 4);

  const grid = board.rows.map((row) => letters(row));
  assert.equal(board.path.map(([r, c]) => grid[r][c]).join(''), board.answer, 'the path spells the answer');
  assert.ok(touching(board.path));
  assert.equal(board.path.length, 12, 'no box is left over, and none is filler');
  assert.equal(board.clue, 'أكبر مدن المغرب');
});

test('an answer that cannot fill a board is refused', () => {
  assert.equal(buildConnect({ id: 1, answer: 'قلم' }, 1), null, 'too short');
  assert.equal(buildConnect({ id: 1, answer: 'القاهرة' }, 1), null, 'seven letters make no rectangle');
  assert.equal(buildConnect({ id: 1, answer: 'hello world' }, 1), null, 'not Arabic');
  assert.equal(buildConnect(null, 1), null);
});

test('the pool keeps only the questions that can make a board', () => {
  const pool = connectPool(rows);
  assert.deepEqual(pool.map((entry) => entry.answer).sort(),
    ['الدار البيضاء', 'جمهورية مصر', 'قارة آسيا'].sort());
  assert.ok(pool.every((entry) => entry.clue), 'a question with nothing to read is left out');
  assert.deepEqual(connectPool([...rows, ...rows]).length, pool.length, 'the same answer is not offered twice');
});

test('a date always asks the same question, and another pick asks a different one', () => {
  const first = connectForDate(rows, '2026-09-23');
  assert.deepEqual(connectForDate(rows, '2026-09-23'), first);
  assert.ok(first.clue, 'every board has something to read');

  const answers = new Set(Array.from({ length: 4 }, (_, i) => connectForDate(rows, '2026-09-23', { nonce: i }).display));
  assert.ok(answers.size > 1, 'another pick moves to another question');
  assert.equal(connectForDate(rows, 'nonsense'), null);
  assert.equal(connectForDate([], '2026-09-23'), null);
});

test('dates move through the questions', () => {
  const week = new Set(Array.from({ length: 6 }, (_, i) => connectForDate(rows, `2026-09-2${i + 1}`).display));
  assert.ok(week.size >= 2, 'neighbouring days do not ask the same thing');
});

test('the day the week gives it sends a board', () => {
  const games = createDailyGames(db, { appConfig: createAppConfig(db) });
  const set = games.forDate('2026-09-23');
  assert.equal(set.kind, 'connect');
  assert.ok(set.connect.rows.length >= CONNECT_SIDES[0]);
  assert.ok(letters(set.connect.answer).length >= CONNECT_LETTERS[0]);
});
