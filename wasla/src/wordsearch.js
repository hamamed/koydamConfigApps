/**
 * Builds a word-search board: a square of Arabic letters hiding a list of words.
 *
 * Pure — no I/O, no clock. The same words, size and seed always give the same
 * board, which is what makes the daily board the same for every player.
 *
 * Coordinates follow the API contract: row 0 is the top row and column 0 is
 * the RIGHT edge (the app draws it there, as in the crossword), so `dCol: 1`
 * runs leftwards on screen, the way Arabic reads. For building the board none
 * of that matters: a word starts at (row, col) and its i-th letter sits at
 * (row + i·dRow, col + i·dCol).
 *
 * Words cross only on equal letters. Words that cannot be placed are dropped
 * and reported. The empty cells are filled with letters weighted by rough
 * Arabic frequency, re-rolled wherever the filler would spell a hidden word a
 * second time — so every word can be found in exactly one place.
 */

import { letters } from './arabic.js';

export const MIN_SIZE = 7;
export const MAX_SIZE = 10;

/** Whole-board tries with different random choices; the one placing most words wins. */
const ATTEMPTS = 30;
/** Rounds of re-rolling the filler cells of a duplicate before refilling from scratch. */
const REROLL_ROUNDS = 50;
const REFILLS = 20;

/** All eight directions as [dRow, dCol], reverse included. */
export const DIRECTIONS = Object.freeze([
  [0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1],
].map((d) => Object.freeze(d)));

/**
 * Filler letters and their relative weights, roughly as often as each appears
 * in written Arabic (ا and ل far ahead; ظ and غ rare).
 *
 * Only letters the player can see on a board appear: the words are in their
 * played form (contract §1), so أ إ آ ٱ ؤ ئ ى never do, and neither do they
 * here. ة and ء are real tiles in played words (فراشة, سماء), so they appear
 * too, rarely — a board where only a hidden word ever had a ة would point
 * straight at that word.
 */
export const FILLER_WEIGHTS = Object.freeze({
  ا: 120, ل: 100, ي: 70, م: 60, و: 60, ن: 60, ر: 50, ه: 40, ت: 40, ب: 40,
  ع: 30, ك: 25, د: 25, س: 25, ف: 25, ق: 20, ح: 20, ة: 15, ج: 15, ش: 10,
  ص: 10, ط: 10, خ: 10, ز: 8, ذ: 8, ث: 6, غ: 6, ض: 6, ظ: 3, ء: 4,
});

const FILLER = Object.entries(FILLER_WEIGHTS);
const FILLER_TOTAL = FILLER.reduce((sum, [, w]) => sum + w, 0);

/** mulberry32, as in layout.js: small, seedable, good enough for a game board. */
export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled(list, rand) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function fillerLetter(rand) {
  let pick = rand() * FILLER_TOTAL;
  for (const [letter, weight] of FILLER) {
    pick -= weight;
    if (pick < 0) return letter;
  }
  return FILLER[0][0];
}

/** The cells `[row, col]` a word covers from (row, col) in direction (dRow, dCol). */
export function cellsOf({ word, row, col, dRow, dCol }) {
  return letters(word).map((_, i) => [row + i * dRow, col + i * dCol]);
}

const inside = (size, r, c) => r >= 0 && c >= 0 && r < size && c < size;

/**
 * Every place `word` can be read in `grid` (a size × size array of letters or
 * null), as sorted cell-index lists. A palindrome read both ways covers the
 * same cells and counts once.
 */
export function occurrences(grid, word) {
  const size = grid.length;
  const list = letters(word);
  const found = new Map();
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (grid[row][col] !== list[0]) continue;
      for (const [dRow, dCol] of DIRECTIONS) {
        const endRow = row + (list.length - 1) * dRow;
        const endCol = col + (list.length - 1) * dCol;
        if (!inside(size, endRow, endCol)) continue;
        let match = true;
        for (let i = 1; i < list.length && match; i++) match = grid[row + i * dRow][col + i * dCol] === list[i];
        if (!match) continue;
        const cells = list.map((_, i) => (row + i * dRow) * size + col + i * dCol).sort((a, b) => a - b);
        found.set(cells.join(','), cells);
      }
    }
  }
  return [...found.values()];
}

/** Whether a word (or its reverse) can be read inside another — it could never be found only once. */
const containedIn = (inner, outer) => outer !== inner && (outer.includes(inner) || outer.includes([...inner].reverse().join('')));

function tryPlace(grid, word, rand, placedWords) {
  const size = grid.length;
  const list = letters(word.word);
  for (const [dRow, dCol] of shuffled(DIRECTIONS, rand)) {
    const starts = [];
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        if (!inside(size, row + (list.length - 1) * dRow, col + (list.length - 1) * dCol)) continue;
        const fits = list.every((letter, i) => {
          const existing = grid[row + i * dRow][col + i * dCol];
          return existing === null || existing === letter;
        });
        if (fits) starts.push([row, col]);
      }
    }
    for (const [row, col] of shuffled(starts, rand)) {
      const cells = cellsOf({ word: word.word, row, col, dRow, dCol });
      // Lying entirely on top of letters already there would hide nothing new.
      if (cells.every(([r, c]) => grid[r][c] !== null)) continue;
      const before = cells.map(([r, c]) => grid[r][c]);
      cells.forEach(([r, c], i) => { grid[r][c] = list[i]; });
      // Letters already placed must not spell any word twice.
      const all = [...placedWords, word];
      if (all.every((w) => occurrences(grid, w.word).length === 1)) return { ...word, row, col, dRow, dCol };
      cells.forEach(([r, c], i) => { grid[r][c] = before[i]; });
    }
  }
  return null;
}

function attempt(ordered, size, rand) {
  const grid = Array.from({ length: size }, () => Array(size).fill(null));
  const placed = [];
  const unplaced = [];
  for (const word of ordered) {
    const spot = tryPlace(grid, word, rand, placed);
    if (spot) placed.push(spot);
    else unplaced.push(word);
  }
  return { grid, placed, unplaced };
}

/**
 * Fills the empty cells, re-rolling any filler cell that makes a placed word
 * readable a second time. Returns the rows, or null if it could not settle.
 */
function fill(grid, placed, rand) {
  const size = grid.length;
  const fixed = grid.map((row) => row.map((letter) => letter !== null));
  for (let refill = 0; refill < REFILLS; refill++) {
    const board = grid.map((row) => row.map((letter) => letter ?? fillerLetter(rand)));
    for (let round = 0; round < REROLL_ROUNDS; round++) {
      const extra = placed.flatMap((w) => {
        const home = cellsOf(w).map(([r, c]) => r * size + c).sort((a, b) => a - b).join(',');
        return occurrences(board, w.word).filter((cells) => cells.join(',') !== home);
      });
      if (!extra.length) return board.map((row) => row.join(''));
      for (const cells of extra) {
        // Placement never makes a duplicate out of placed letters alone, so
        // every extra reading has at least one filler cell to change.
        const free = cells.filter((i) => !fixed[Math.floor(i / size)][i % size]);
        if (!free.length) return null;
        const cell = free[Math.floor(rand() * free.length)];
        board[Math.floor(cell / size)][cell % size] = fillerLetter(rand);
      }
    }
  }
  return null;
}

/**
 * `{ size, rows, words, dropped }` for `words` ({ id, word, display }, `word`
 * in its played form) on a `size` × `size` board.
 *
 * - `rows`: `size` strings of `size` letters, row 0 on top.
 * - `words`: the placed words, in the order given, with `row`, `col`, `dRow`, `dCol`.
 * - `dropped`: `{ id, word, reason }` for words not on the board — longer than
 *   the board (`too-long`), readable inside another word (`contained`), or no
 *   room left (`no-room`).
 */
export function buildBoard({ words, size, seed = 1 }) {
  if (!Number.isInteger(size) || size < MIN_SIZE || size > MAX_SIZE) {
    throw new RangeError(`A word-search board is ${MIN_SIZE} to ${MAX_SIZE} letters square.`);
  }
  const list = (Array.isArray(words) ? words : []).map((word, order) => ({ ...word, order, length: letters(String(word.word ?? '')).length }));
  const dropped = [];
  const usable = [];
  for (const word of list) {
    // A word readable inside a longer one (or the reverse of an earlier one of
    // the same length, like نمر and رمن) would be found in two places.
    const hiddenIn = (other) => other !== word && other.length <= size && containedIn(word.word, other.word)
      && (other.length > word.length || other.order < word.order);
    if (word.length === 0 || word.length > size) {
      dropped.push({ id: word.id, word: word.word, reason: 'too-long' });
    } else if (list.some(hiddenIn)) {
      dropped.push({ id: word.id, word: word.word, reason: 'contained' });
    } else {
      usable.push(word);
    }
  }

  const rand = random(seed);
  // Longest first: the long words need the room, the short ones fit around them.
  const byLength = [...usable].sort((a, b) => b.length - a.length || a.order - b.order);
  let best = attempt(byLength, size, rand);
  for (let n = 1; n < ATTEMPTS && best.unplaced.length; n++) {
    const result = attempt(byLength, size, rand);
    if (result.placed.length > best.placed.length) best = result;
  }

  const rows = fill(best.grid, best.placed, rand);
  if (!rows) throw new Error('Could not fill the word-search board.');
  for (const word of [...best.unplaced].sort((a, b) => a.order - b.order)) {
    dropped.push({ id: word.id, word: word.word, reason: 'no-room' });
  }
  const placed = [...best.placed].sort((a, b) => a.order - b.order);

  return {
    size,
    rows,
    words: placed.map(({ id, word, display, row, col, dRow, dCol }) => ({ id, word, display, row, col, dRow, dCol })),
    dropped,
  };
}
