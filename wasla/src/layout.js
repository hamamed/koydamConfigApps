/**
 * Builds a crossword from a list of answers.
 *
 * The panel only asks for questions; where each word sits is worked out here,
 * so adding a question to a level never means placing tiles by hand.
 *
 * Coordinates are logical: `across` advances the column, `down` advances the
 * row. The app draws column 0 at the right edge, so an across word reads right
 * to left the way Arabic does — this module does not need to know that.
 */

import { letters } from './arabic.js';

const ATTEMPTS = 40;

/** The cells a placed word covers, in reading order. */
export function cellsOf({ answer, row, col, direction }) {
  return letters(answer).map((letter, i) => ({
    row: direction === 'down' ? row + i : row,
    col: direction === 'across' ? col + i : col,
    letter,
  }));
}

/** Small, seedable PRNG, so a given seed always yields the same grid. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(list, rand) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const key = (row, col) => `${row},${col}`;

/** A grid being filled: letters per cell, and which directions pass through it. */
class Board {
  constructor() {
    this.cells = new Map();
    this.placements = [];
    this.bounds = null;
  }

  letterAt(row, col) {
    return this.cells.get(key(row, col))?.letter;
  }

  /** Crossings the word would make, or -1 when it cannot go there. */
  fit(word, row, col, direction) {
    const list = letters(word.answer);
    const [dr, dc] = direction === 'down' ? [1, 0] : [0, 1];
    // The cells just before and after the word must be empty, or it would run
    // straight into another word and read as one longer one.
    if (this.letterAt(row - dr, col - dc) || this.letterAt(row + dr * list.length, col + dc * list.length)) return -1;

    let crossings = 0;
    for (let i = 0; i < list.length; i++) {
      const r = row + dr * i;
      const c = col + dc * i;
      const existing = this.cells.get(key(r, c));
      if (existing) {
        if (existing.letter !== list[i] || existing.directions.has(direction)) return -1;
        crossings++;
        continue;
      }
      // A new letter must not sit beside another word's letter, or the two
      // form a run nobody asked for.
      const [sr, sc] = direction === 'down' ? [0, 1] : [1, 0];
      if (this.letterAt(r - sr, c - sc) || this.letterAt(r + sr, c + sc)) return -1;
    }
    return crossings;
  }

  place(word, row, col, direction) {
    for (const cell of cellsOf({ answer: word.answer, row, col, direction })) {
      const k = key(cell.row, cell.col);
      const existing = this.cells.get(k) ?? { letter: cell.letter, directions: new Set() };
      existing.directions.add(direction);
      this.cells.set(k, existing);
      this.grow(cell.row, cell.col);
    }
    this.placements.push({ id: word.id, row, col, direction });
  }

  grow(row, col) {
    const b = this.bounds ?? { top: row, bottom: row, left: col, right: col };
    this.bounds = {
      top: Math.min(b.top, row), bottom: Math.max(b.bottom, row),
      left: Math.min(b.left, col), right: Math.max(b.right, col),
    };
  }

  /** Area of the bounding box if the word were placed there. */
  areaWith(word, row, col, direction) {
    const n = letters(word.answer).length;
    const endRow = direction === 'down' ? row + n - 1 : row;
    const endCol = direction === 'across' ? col + n - 1 : col;
    const b = this.bounds;
    const height = Math.max(b.bottom, endRow) - Math.min(b.top, row) + 1;
    const width = Math.max(b.right, endCol) - Math.min(b.left, col) + 1;
    // Squarish grids fit a phone better than a long ribbon of the same area.
    return height * width + Math.abs(height - width) * 2;
  }

  /** The best spot crossing an existing word, or null. */
  bestSpot(word) {
    const list = letters(word.answer);
    let best = null;
    for (const [k, cell] of this.cells) {
      const [row, col] = k.split(',').map(Number);
      for (let i = 0; i < list.length; i++) {
        if (list[i] !== cell.letter) continue;
        for (const direction of ['across', 'down']) {
          if (cell.directions.has(direction)) continue;
          const r = direction === 'down' ? row - i : row;
          const c = direction === 'across' ? col - i : col;
          const crossings = this.fit(word, r, c, direction);
          if (crossings < 1) continue;
          const score = crossings * 100 - this.areaWith(word, r, c, direction);
          if (!best || score > best.score) best = { row: r, col: c, direction, score };
        }
      }
    }
    return best;
  }
}

function attempt(order) {
  const board = new Board();
  const [first, ...rest] = order;
  board.place(first, 0, 0, 'across');

  let pending = rest;
  let progressed = true;
  // Several passes: a word with no crossing yet may find one once a later word lands.
  while (pending.length && progressed) {
    progressed = false;
    const left = [];
    for (const word of pending) {
      const spot = board.bestSpot(word);
      if (spot) {
        board.place(word, spot.row, spot.col, spot.direction);
        progressed = true;
      } else {
        left.push(word);
      }
    }
    pending = left;
  }
  return { board, unplaced: pending };
}

function better(a, b) {
  if (!b) return true;
  if (a.unplaced.length !== b.unplaced.length) return a.unplaced.length < b.unplaced.length;
  return a.area < b.area;
}

/**
 * Lays out `words` ({ id, answer }) as a connected crossword.
 *
 * Tries several orderings and keeps the one that places the most words in the
 * smallest grid. Words that share no letter with the rest come back in
 * `unplaced`, by id, for the panel to report.
 */
export function generateLayout(words, { seed = 1 } = {}) {
  if (!words.length) return { rows: 0, cols: 0, placements: [], unplaced: [] };

  const rand = random(seed);
  const byLength = [...words].sort((a, b) => letters(b.answer).length - letters(a.answer).length);
  let best = null;

  for (let n = 0; n < ATTEMPTS; n++) {
    // The first attempt is longest-first, the usual best start; the rest vary it.
    const order = n === 0 ? byLength : shuffled(byLength, rand);
    const { board, unplaced } = attempt(order);
    const b = board.bounds;
    const result = { board, unplaced, area: (b.bottom - b.top + 1) * (b.right - b.left + 1) };
    if (better(result, best)) best = result;
    if (best.unplaced.length === 0 && n >= 10) break;
  }

  const { top, bottom, left, right } = best.board.bounds;
  const order = new Map(words.map((w, i) => [w.id, i]));
  const unplacedIds = new Set(best.unplaced.map((w) => w.id));

  return {
    rows: bottom - top + 1,
    cols: right - left + 1,
    placements: best.board.placements
      .map((p) => ({ ...p, row: p.row - top, col: p.col - left }))
      .sort((a, b) => order.get(a.id) - order.get(b.id)),
    unplaced: words.filter((w) => unplacedIds.has(w.id)).map((w) => w.id),
  };
}
