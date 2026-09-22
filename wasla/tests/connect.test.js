import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { createAppConfig } from '../src/app-config.js';
import { foldForPlay, letters } from '../src/arabic.js';
import {
  buildConnect, chooseWords, CONNECT_LETTERS, CONNECT_SHAPES, CONNECT_WORDS, connectForDate, connectPool,
} from '../src/connect.js';
import { createDailyGames } from '../src/daily-games.js';
import { openDatabase } from '../src/db/index.js';
import { createRepository } from '../src/repository.js';

/** Two titles with enough short answers to fill a board exactly. */
const BANK = [
  ['مدرسة', 'أداة للكتابة', 'قلم'],
  ['مدرسة', 'مكان الدراسة', 'مدرسة'],
  ['مدرسة', 'من يعلّم الطلاب', 'معلم'],
  ['مدرسة', 'يُكتب فيه الدرس', 'دفتر'],
  ['مدرسة', 'حصة دراسية', 'درس'],
  ['مدرسة', 'يجلس عليه الطالب', 'مقعد'],
  ['مدرسة', 'يمحو الخطأ', 'ممحاة'],
  ['مطبخ', 'يُطبخ فيها', 'قدر'],
  ['مطبخ', 'تُقطع به الخضر', 'سكين'],
  ['مطبخ', 'يُشرب فيه الشاي', 'كأس'],
  ['مطبخ', 'يحفظ الطعام باردًا', 'ثلاجة'],
  ['مطبخ', 'يُخبز فيه', 'فرن'],
  ['مطبخ', 'يُؤكل فيه', 'طبق'],
  ['مدن', 'أكبر مدن المغرب', 'الدار البيضاء'],   // eight letters: too long for a board
  ['مدن', '', 'مراكش'],                          // nothing to read
];

/** How many of each letter something is made of. */
const counts = (list) => list.reduce((seen, letter) => seen.set(letter, (seen.get(letter) ?? 0) + 1), new Map());

let db;
let rows;

beforeEach(() => {
  db = openDatabase(':memory:');
  const repo = createRepository(db);
  BANK.forEach(([title, clue, answer]) => repo.createQuestion({ title, answer, clue }));
  rows = db.prepare(`SELECT id, answer, IFNULL(clue, '') AS clue, IFNULL(emoji, '') AS emoji,
    trim(IFNULL(title, '')) AS title FROM questions ORDER BY id`).all();
});

test('the words chosen fill the board exactly, or none are', () => {
  const entries = [
    { id: 1, word: 'قلم', size: 3 }, { id: 2, word: 'معلم', size: 4 },
    { id: 3, word: 'دفتر', size: 4 }, { id: 4, word: 'ممحاة', size: 5 },
  ];
  const chosen = chooseWords(entries, 12);
  assert.equal(chosen.reduce((sum, entry) => sum + entry.size, 0), 12);
  assert.ok(chosen.length >= CONNECT_WORDS[0]);
  assert.equal(chooseWords(entries, 14), null, 'a box would be left over');
  assert.equal(chooseWords(entries, 7), null, 'two words are not a board');
  assert.equal(chooseWords([], 12), null);
});

test('every box of the board belongs to one answer', () => {
  const board = buildConnect(connectPool(rows.filter((row) => row.title === 'مدرسة')), 42);
  const [shape] = CONNECT_SHAPES;
  assert.equal(board.rows.length * board.cols, shape[0] * shape[1], 'the biggest board it can fill');
  assert.equal(board.rows.flatMap((row) => letters(row)).length, board.rows.length * board.cols, 'no box is empty');

  const onBoard = counts(board.rows.flatMap((row) => letters(row)));
  const inWords = counts(board.words.flatMap((word) => letters(word.word)));
  assert.deepEqual([...onBoard].sort(), [...inWords].sort(),
    'the board is the answers letter for letter: no filler, and nothing shared');

  for (const word of board.words) {
    assert.equal(word.word, foldForPlay(word.display));
    assert.ok(word.clue, 'every answer has something to read');
  }
  assert.deepEqual([...board.words].sort((a, b) => letters(a.word).length - letters(b.word).length), board.words,
    'the shortest answer is asked first');
});

test('a smaller board is used when the biggest cannot be filled', () => {
  // Three answers of four letters fill 3×4 and nothing larger.
  const pool = connectPool([
    { id: 1, answer: 'معلم', clue: 'من يعلّم', title: 'مدرسة' },
    { id: 2, answer: 'دفتر', clue: 'يُكتب فيه', title: 'مدرسة' },
    { id: 3, answer: 'مقعد', clue: 'يجلس عليه', title: 'مدرسة' },
  ]);
  const board = buildConnect(pool, 3);
  assert.deepEqual([board.rows.length, board.cols], [3, 4]);
  assert.equal(board.words.length, 3);
});

test('answers that fill no board at all make no board', () => {
  assert.equal(buildConnect([], 1), null);
  assert.equal(buildConnect(connectPool([
    { id: 1, answer: 'قلم', clue: 'أداة', title: 'مدرسة' },
    { id: 2, answer: 'درس', clue: 'حصة', title: 'مدرسة' },
  ]), 1), null, 'six letters fill nothing');
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
  assert.equal(first.words.reduce((sum, word) => sum + letters(word.word).length, 0),
    first.rows.length * first.cols);

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
  assert.equal(connectForDate(thin, '2026-09-23').theme, 'مطبخ', 'مدن cannot fill one, so the day lands on مطبخ');
});

test('the day the week gives it sends a board', () => {
  const games = createDailyGames(db, { appConfig: createAppConfig(db) });
  const set = games.forDate('2026-09-23');
  assert.equal(set.kind, 'connect');
  assert.ok(set.connect.words.length >= CONNECT_WORDS[0]);
  assert.equal(set.connect.words.reduce((sum, word) => sum + letters(word.word).length, 0),
    set.connect.rows.length * set.connect.cols);
});
