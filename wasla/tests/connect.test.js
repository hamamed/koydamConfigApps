import assert from 'node:assert/strict';
import { test } from 'node:test';

import { letters } from '../src/arabic.js';
import {
  buildPictureConnect, CONNECT_LETTERS, CONNECT_MAX_ROWS, CONNECT_WORDS, connectForDate, PICTURE_ASK,
  pictureWords, shapeFor, walk,
} from '../src/connect.js';
import { random } from '../src/wordsearch.js';

const SUN = Object.freeze({
  id: 3,
  title: 'الشمس',
  words: ['ضوء', 'صيف', 'حرارة', 'نهار', 'شروق', 'أشعة', 'فصول', 'جمال'],
  image: { url: 'https://example.test/sun.png', zoom: 1, focusX: 0.5, focusY: 0.5 },
});

const pictures = (round = SUN) => ({ forDate: () => round });
const grid = (board) => board.rows.map((row) => [...row]);

test('the shape is as few rows as the letters allow, and as full as it can be', () => {
  assert.deepEqual(shapeFor(36), { cols: 6, rows: 6 }, 'six sixes exactly');
  assert.deepEqual(shapeFor(40), { cols: 6, rows: 7 }, 'seven rows of six beats eight of five');
  assert.deepEqual(shapeFor(26), { cols: 6, rows: 5 });
  assert.equal(shapeFor(300), null, `over ${CONNECT_MAX_ROWS} rows is taller than a phone`);
});

test('the walk visits every box once and never the ones the words do not reach', () => {
  const blocked = new Set(['3,3', '3,4']);
  const path = walk(4, 5, random(9), blocked);
  assert.equal(path.length, 4 * 5 - blocked.size);
  assert.equal(new Set(path.map(String)).size, path.length, 'each box once');
  assert.ok(path.every(([row, col]) => !blocked.has(`${row},${col}`)), 'and none of the missing ones');
  path.forEach(([row, col], index) => {
    if (index === 0) return;
    const [before, beside] = path[index - 1];
    assert.equal(Math.abs(row - before) + Math.abs(col - beside), 1, 'one step, no diagonals');
  });
});

test('a picture board holds all eight of its words, letter for letter', () => {
  const board = buildPictureConnect(SUN, 7);
  assert.equal(board.words.length, 8, 'the whole picture');
  assert.equal(board.theme, 'الشمس');
  assert.equal(board.ask, PICTURE_ASK, 'the picture asks, so the words need no clue');
  assert.equal(board.image.url, SUN.image.url);

  const boxes = grid(board).flat().filter((cell) => cell !== ' ');
  const needed = board.words.flatMap((word) => letters(word.word));
  assert.deepEqual([...boxes].sort(), [...needed].sort(), 'the board is the words and nothing else');
  assert.ok(board.rows.every((row) => [...row].length === board.cols), 'every row is the board wide');
});

test('each word reads from its own run of boxes, side by side', () => {
  const board = buildPictureConnect(SUN, 11);
  const cells = grid(board);
  const seen = new Set();
  for (const word of board.words) {
    assert.equal(word.cells.map(([r, c]) => cells[r][c]).join(''), word.word, `${word.display} reads from its boxes`);
    word.cells.forEach(([row, col], index) => {
      assert.ok(!seen.has(`${row},${col}`), 'no box belongs to two words');
      seen.add(`${row},${col}`);
      if (index === 0) return;
      const [before, beside] = word.cells[index - 1];
      assert.equal(Math.abs(row - before) + Math.abs(col - beside), 1, `${word.display} keeps its letters together`);
    });
  }
  assert.equal(seen.size, cells.flat().filter((cell) => cell !== ' ').length, 'and between them they cover the board');
});

test('the last row ends where the words do', () => {
  const board = buildPictureConnect(SUN, 3);
  const cells = grid(board);
  const blanks = cells.flat().filter((cell) => cell === ' ').length;
  assert.ok(blanks < board.cols, 'at most a row short of one');
  for (const [index, row] of cells.entries()) {
    if (index < cells.length - 1) assert.ok(!row.includes(' '), `row ${index} is full`);
  }
});

test('a word too long, doubled or not Arabic is not asked for', () => {
  const asked = pictureWords({ words: ['ضوء', 'ضوء', 'حرارة', 'الشمسالساطعة', 'sun', 'حر'] });
  assert.deepEqual(asked.map((word) => word.display), ['ضوء', 'حرارة']);
  assert.ok(asked.every((word) => letters(word.word).length >= CONNECT_LETTERS[0]));
});

test('a picture with too few words it can ask for makes no board', () => {
  assert.equal(buildPictureConnect({ title: 'الشمس', words: ['ضوء', 'صيف'] }, 3), null);
  assert.equal(buildPictureConnect(null, 3), null);
});

test('the words step aside until the board fits a phone', () => {
  // Eight words of seven letters are fifty-six boxes: too tall for any width.
  const long = { title: 'طويلة', words: Array.from({ length: 8 }, (_, i) => `مطبخ${'ابتثجحخد'[i]}ون`) };
  const board = buildPictureConnect(long, 5);
  assert.ok(board.rows.length <= CONNECT_MAX_ROWS, `${board.rows.length} rows`);
  assert.ok(board.words.length >= CONNECT_WORDS[0] && board.words.length < CONNECT_WORDS[1],
    'some stepped aside, and enough stayed for a game');
});

test('a date plays its picture, and another pick moves to another', () => {
  const first = connectForDate(null, '2026-09-23', { pictures: pictures() });
  assert.deepEqual(connectForDate(null, '2026-09-23', { pictures: pictures() }), first, 'the same date, the same board');
  assert.equal(first.theme, 'الشمس');
  assert.equal(connectForDate(null, 'nonsense', { pictures: pictures() }), null);
  assert.equal(connectForDate(null, '2026-09-23', { pictures: { forDate: () => null } }), null, 'no picture, no board');
  assert.equal(connectForDate(null, '2026-09-23'), null);
});
