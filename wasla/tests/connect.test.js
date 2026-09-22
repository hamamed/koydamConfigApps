import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { createAppConfig } from '../src/app-config.js';
import { foldForPlay, letters } from '../src/arabic.js';
import {
  buildConnect, CONNECT_BOXES, CONNECT_COLS, CONNECT_LETTERS, CONNECT_MIN_WORDS, CONNECT_ROWS,
  CONNECT_WORDS, connectForDate, connectPool, poolFor,
} from '../src/connect.js';
import { createDailyGames } from '../src/daily-games.js';
import { openDatabase } from '../src/db/index.js';
import { createRepository } from '../src/repository.js';

/** Two titles with enough short answers to pool into a board. */
const BANK = [
  ['مدرسة', 'أداة للكتابة', 'قلم'],
  ['مدرسة', 'مكان الدراسة', 'مدرسة'],
  ['مدرسة', 'من يعلّم الطلاب', 'معلم'],
  ['مدرسة', 'يُكتب فيه الدرس', 'دفتر'],
  ['مدرسة', 'حصة دراسية', 'درس'],
  ['مدرسة', 'يجلس عليه الطالب', 'مقعد'],
  ['مطبخ', 'يُطبخ فيها', 'قدر'],
  ['مطبخ', 'تُقطع به الخضر', 'سكين'],
  ['مطبخ', 'يُشرب فيه الشاي', 'كأس'],
  ['مطبخ', 'يحفظ الطعام باردًا', 'ثلاجة'],
  ['مطبخ', 'يُخبز فيه', 'فرن'],
  ['مطبخ', 'يُؤكل فيه', 'طبق'],
  ['مدن', 'أكبر مدن المغرب', 'الدار البيضاء'],   // eight letters: too long to pool
  ['مدن', '', 'مراكش'],                          // nothing to read
];

/** Every letter an answer needs is on the board, counting repeats. */
const spellable = (word, board) => {
  const box = new Map();
  for (const letter of board.rows.flatMap((row) => letters(row))) box.set(letter, (box.get(letter) ?? 0) + 1);
  for (const letter of letters(word)) {
    const left = box.get(letter) ?? 0;
    if (left === 0) return false;
    box.set(letter, left - 1);
  }
  return true;
};

let db;
let rows;

beforeEach(() => {
  db = openDatabase(':memory:');
  const repo = createRepository(db);
  BANK.forEach(([title, clue, answer]) => repo.createQuestion({ title, answer, clue }));
  rows = db.prepare(`SELECT id, answer, IFNULL(clue, '') AS clue, IFNULL(emoji, '') AS emoji,
    trim(IFNULL(title, '')) AS title FROM questions ORDER BY id`).all();
});

test('the pool holds the most any one word needs of each letter', () => {
  assert.deepEqual(poolFor(['قلم']).sort(), ['ق', 'ل', 'م'].sort());
  assert.deepEqual(poolFor(['قلم', 'ملق']).sort(), ['ق', 'ل', 'م'].sort(), 'the same letters serve both');
  assert.deepEqual(poolFor(['درس', 'مدرسة']).sort(), ['د', 'ر', 'س', 'م', 'ة'].sort(), 'درس is spelled from مدرسة');
  assert.equal(poolFor(['ددد', 'دد']).length, 3, 'three of a letter when one word wants three');
});

test('a board is the words\' own letters, every box filled', () => {
  const board = buildConnect(connectPool(rows.filter((row) => row.title === 'مدرسة')), 42);
  assert.equal(board.rows.length, CONNECT_ROWS);
  assert.equal(board.cols, CONNECT_COLS);
  assert.equal(board.rows.flatMap((row) => letters(row)).length, CONNECT_BOXES, 'no box is empty');
  assert.equal(board.words.length, CONNECT_WORDS);

  for (const word of board.words) {
    assert.ok(spellable(word.word, board), `${word.display} is on the board`);
    assert.equal(word.word, foldForPlay(word.display));
    assert.ok(word.clue, 'every word has something to read');
  }
  assert.deepEqual([...board.words].sort((a, b) => letters(a.word).length - letters(b.word).length), board.words,
    'the shortest word is asked first');
});

test('a board only holds letters its words need', () => {
  const board = buildConnect(connectPool(rows.filter((row) => row.title === 'مطبخ')), 7);
  const needed = new Set(board.words.flatMap((word) => letters(word.word)));
  for (const letter of board.rows.flatMap((row) => letters(row))) {
    assert.ok(needed.has(letter), `${letter} belongs to one of the words`);
  }
});

test('too few words, or none short enough, makes no board', () => {
  const pool = connectPool(rows.filter((row) => row.title === 'مدرسة'));
  assert.equal(buildConnect(pool.slice(0, CONNECT_MIN_WORDS - 1), 1), null, 'two words are not a board');
  assert.equal(buildConnect([], 1), null);
  assert.equal(buildConnect([{ id: 1, word: 'الدارالبيضاء', display: 'الدار البيضاء', clue: 'مدينة' }], 1), null);
});

test('the pool keeps the questions a board can ask', () => {
  const pool = connectPool(rows);
  const answers = pool.map((entry) => entry.display);
  assert.ok(answers.includes('قلم') && answers.includes('ثلاجة'));
  assert.ok(!answers.includes('الدار البيضاء'), `over ${CONNECT_LETTERS[1]} letters`);
  assert.ok(!answers.includes('مراكش'), 'nothing to read');
  assert.equal(connectPool([...rows, ...rows]).length, pool.length, 'the same answer is not offered twice');
});

test('a word carries its emoji to the app', () => {
  const pool = connectPool([{ id: 1, answer: 'قلم', clue: 'أداة للكتابة', emoji: '✏️', title: 'مدرسة' }]);
  assert.equal(pool[0].emoji, '✏️');
});

test('a date always plays the same board, and another pick changes it', () => {
  const first = connectForDate(rows, '2026-09-23');
  assert.deepEqual(connectForDate(rows, '2026-09-23'), first);
  assert.ok(first.theme, 'a board is about one thing');
  assert.ok(first.words.every((word) => spellable(word.word, first)));

  const seen = new Set(Array.from({ length: 4 }, (_, i) =>
    connectForDate(rows, '2026-09-23', { nonce: i }).words.map((w) => w.display).join()));
  assert.ok(seen.size > 1, 'another pick asks something else');
  assert.equal(connectForDate(rows, 'nonsense'), null);
  assert.equal(connectForDate([], '2026-09-23'), null);
});

test('dates move through the titles', () => {
  const themes = new Set(Array.from({ length: 4 }, (_, i) => connectForDate(rows, `2026-09-2${i + 1}`).theme));
  assert.ok(themes.size >= 2, 'neighbouring days are not about the same thing');
});

test('a title too thin for a board passes the day on', () => {
  const thin = rows.filter((row) => row.title !== 'مدرسة');
  const board = connectForDate(thin, '2026-09-23');
  assert.equal(board.theme, 'مطبخ', 'مدن has one usable question, so the day lands on مطبخ');
});

test('the day the week gives it sends a board', () => {
  const games = createDailyGames(db, { appConfig: createAppConfig(db) });
  const set = games.forDate('2026-09-23');
  assert.equal(set.kind, 'connect');
  assert.equal(set.connect.rows.length, CONNECT_ROWS);
  assert.ok(set.connect.words.length >= CONNECT_MIN_WORDS);
});
