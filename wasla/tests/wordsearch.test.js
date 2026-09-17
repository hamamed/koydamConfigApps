import assert from 'node:assert/strict';
import { test } from 'node:test';

import { letters } from '../src/arabic.js';
import { buildBoard, cellsOf, DIRECTIONS, FILLER_WEIGHTS, occurrences } from '../src/wordsearch.js';

const ANIMALS = ['اسد', 'نمر', 'فيل', 'زرافة', 'حصان', 'غزال', 'دب', 'قرد', 'جمل', 'تمساح']
  .map((word, i) => ({ id: i + 1, word, display: word }));

const gridOf = (board) => board.rows.map((row) => [...row]);

function assertBoardValid(board, size) {
  assert.equal(board.size, size);
  assert.equal(board.rows.length, size);
  for (const row of board.rows) assert.equal(letters(row).length, size);
  const grid = gridOf(board);
  for (const w of board.words) {
    assert.ok(DIRECTIONS.some(([r, c]) => r === w.dRow && c === w.dCol), `direction ${w.dRow},${w.dCol}`);
    const spelled = cellsOf(w).map(([r, c]) => {
      assert.ok(r >= 0 && c >= 0 && r < size && c < size, `${w.word} leaves the board`);
      return grid[r][c];
    }).join('');
    assert.equal(spelled, w.word);
  }
}

test('every placed word reads from its cells, on every size from 7 to 10', () => {
  for (const size of [7, 8, 9, 10]) {
    for (let seed = 1; seed <= 5; seed++) {
      const board = buildBoard({ words: ANIMALS, size, seed });
      assertBoardValid(board, size);
      assert.ok(board.words.length >= 6, `size ${size} seed ${seed}: ${board.words.length} words`);
      // Placed and dropped together account for every word given.
      assert.equal(board.words.length + board.dropped.length, ANIMALS.length);
    }
  }
});

test('the same words, size and seed give the same board; another seed another board', () => {
  const a = buildBoard({ words: ANIMALS, size: 9, seed: 42 });
  assert.deepEqual(buildBoard({ words: ANIMALS, size: 9, seed: 42 }), a);
  assert.notDeepEqual(buildBoard({ words: ANIMALS, size: 9, seed: 43 }).rows, a.rows);
});

test('all eight directions occur across seeds', () => {
  const seen = new Set();
  for (let seed = 1; seed <= 20; seed++) {
    for (const w of buildBoard({ words: ANIMALS, size: 10, seed }).words) seen.add(`${w.dRow},${w.dCol}`);
  }
  assert.equal(seen.size, 8);
});

test('no word can be read in a second place, filler included', () => {
  // Short words over common letters are the likeliest to turn up by chance.
  const common = ['ملل', 'نار', 'لون', 'يوم', 'امل', 'بلد', 'ولد'].map((word, i) => ({ id: i + 1, word, display: word }));
  for (let seed = 1; seed <= 40; seed++) {
    for (const words of [ANIMALS, common]) {
      const board = buildBoard({ words, size: 7, seed });
      const grid = gridOf(board);
      for (const w of board.words) assert.equal(occurrences(grid, w.word).length, 1, `seed ${seed}: ${w.word}`);
    }
  }
});

test('words longer than the board are dropped and reported, not placed', () => {
  const words = [...ANIMALS.slice(0, 6), { id: 99, word: 'البرتقالة', display: 'البرتقالة' }];
  const board = buildBoard({ words, size: 8, seed: 3 });
  assert.equal(board.words.some((w) => w.id === 99), false);
  assert.deepEqual(board.dropped.find((d) => d.id === 99), { id: 99, word: 'البرتقالة', reason: 'too-long' });
  // On a 9-board the same word fits.
  assert.ok(buildBoard({ words, size: 9, seed: 3 }).words.some((w) => w.id === 99));
});

test('a word readable inside another, or reversed as an earlier one, is dropped', () => {
  const words = [
    { id: 1, word: 'نمر', display: 'نمر' },
    { id: 2, word: 'نمرة', display: 'نمرة' },
    { id: 3, word: 'رمن', display: 'رمن' },
    { id: 4, word: 'فيل', display: 'فيل' },
    { id: 5, word: 'ليف', display: 'ليف' },
  ];
  const board = buildBoard({ words, size: 7, seed: 1 });
  assert.deepEqual(board.words.map((w) => w.id).sort(), [2, 4]);
  assert.deepEqual(board.dropped.map((d) => [d.id, d.reason]).sort(), [[1, 'contained'], [3, 'contained'], [5, 'contained']]);
});

test('placed words keep the order given and carry id, word and display', () => {
  const words = [{ id: 7, word: 'اسد', display: 'أسد' }, ...ANIMALS.slice(1, 6)];
  const board = buildBoard({ words, size: 8, seed: 5 });
  assert.deepEqual(board.words.map((w) => w.id), words.map((w) => w.id));
  assert.deepEqual(Object.keys(board.words[0]).sort(), ['col', 'dCol', 'dRow', 'display', 'id', 'row', 'word']);
  assert.equal(board.words[0].display, 'أسد');
});

test('filler letters are all played forms, and none is a folded-away letter', () => {
  for (const folded of ['أ', 'إ', 'آ', 'ٱ', 'ؤ', 'ئ', 'ى']) assert.equal(folded in FILLER_WEIGHTS, false, folded);
  const board = buildBoard({ words: ANIMALS.slice(0, 6), size: 10, seed: 9 });
  const allowed = new Set([...Object.keys(FILLER_WEIGHTS), ...ANIMALS.flatMap((w) => letters(w.word))]);
  for (const row of board.rows) for (const ch of row) assert.ok(allowed.has(ch), ch);
});

test('a size outside 7 to 10 is refused', () => {
  for (const size of [6, 11, 8.5, '8', undefined]) {
    assert.throws(() => buildBoard({ words: ANIMALS, size, seed: 1 }), RangeError, String(size));
  }
});
