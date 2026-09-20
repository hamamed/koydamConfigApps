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

const ATTEMPTS = 60;
/**
 * What one crossing is worth against one cell of grid area when two layouts of the
 * same words are compared. A crossed letter is a free hint — the player reads it
 * from the word they already solved — so a denser grid beats a slightly smaller one.
 */
const CROSSING_WORTH = 12;

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

  /** Letters shared by two words: the hints a solved word gives the next one. */
  get crossings() {
    let shared = 0;
    for (const cell of this.cells.values()) {
      if (cell.directions.size > 1) shared += 1;
    }
    return shared;
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
          if (!best || score > best.score) best = { row: r, col: c, direction, score, crossings };
        }
      }
    }
    return best;
  }
}

/** A board holding exactly these placements, so a word can be tried elsewhere. */
function rebuild(placements, byId) {
  const board = new Board();
  for (const placement of placements) {
    board.place(byId.get(placement.id), placement.row, placement.col, placement.direction);
  }
  return board;
}

/** Whether every word still touches the others: one crossword, not two beside each other. */
function connected(board, byId) {
  if (board.placements.length < 2) return true;
  const owners = new Map();
  for (const placement of board.placements) {
    for (const cell of cellsOf({ ...placement, answer: byId.get(placement.id).answer })) {
      const k = key(cell.row, cell.col);
      owners.set(k, [...(owners.get(k) ?? []), placement.id]);
    }
  }
  const neighbours = new Map(board.placements.map((p) => [p.id, new Set()]));
  for (const ids of owners.values()) {
    for (const a of ids) for (const b of ids) if (a !== b) neighbours.get(a).add(b);
  }
  const seen = new Set([board.placements[0].id]);
  const queue = [board.placements[0].id];
  while (queue.length) {
    for (const next of neighbours.get(queue.pop())) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return seen.size === board.placements.length;
}

/**
 * Takes each word out in turn and puts it back where it crosses most.
 *
 * The first pass places words one after another, so a word lands at the first
 * spot that works and usually crosses just one other — a grid the player can
 * only read one word at a time. Moving a word once its neighbours are down
 * often buys a second or third crossing, and every crossing is a letter the
 * next answer starts with.
 */
function densify(board, byId, rounds = 3) {
  let current = board;
  for (let round = 0; round < rounds; round++) {
    let improved = false;
    for (const placement of [...current.placements]) {
      const rest = current.placements.filter((p) => p.id !== placement.id);
      if (!rest.length) continue;
      const without = rebuild(rest, byId);
      const word = byId.get(placement.id);
      const spot = without.bestSpot(word);
      if (!spot) continue;
      const candidate = rebuild([...rest, { id: placement.id, row: spot.row, col: spot.col, direction: spot.direction }], byId);
      if (candidate.crossings <= current.crossings) continue;
      if (!connected(candidate, byId)) continue;
      current = candidate;
      improved = true;
    }
    if (!improved) break;
  }
  return current;
}

function attempt(order) {
  const board = new Board();
  const [first, ...rest] = order;
  board.place(first, 0, 0, 'across');

  let pending = rest;
  // The word that can cross the most goes down first: taking the best crossing
  // while it is still free beats placing words in whatever order they came in.
  while (pending.length) {
    let choice = null;
    for (const word of pending) {
      const spot = board.bestSpot(word);
      if (!spot) continue;
      if (!choice || spot.crossings > choice.spot.crossings
        || (spot.crossings === choice.spot.crossings && spot.score > choice.spot.score)) {
        choice = { word, spot };
      }
    }
    if (!choice) break;
    board.place(choice.word, choice.spot.row, choice.spot.col, choice.spot.direction);
    pending = pending.filter((word) => word !== choice.word);
  }
  return { board, unplaced: pending };
}

function better(a, b) {
  if (!b) return true;
  if (a.unplaced.length !== b.unplaced.length) return a.unplaced.length < b.unplaced.length;
  // Crossings first, area second: a grid where the words meet often is the one
  // a player can work out, even when it takes a row more than the tightest.
  return a.crossings * CROSSING_WORTH - a.area > b.crossings * CROSSING_WORTH - b.area;
}

/**
 * Lays out `words` ({ id, answer }) as a connected crossword.
 *
 * Tries several orderings and keeps the one that places the most words in the
 * smallest grid. Words that share no letter with the rest come back in
 * `unplaced`, by id, for the panel to report.
 */
export function generateLayout(words, { seed = 1 } = {}) {
  if (!words.length) return { rows: 0, cols: 0, crossings: 0, placements: [], unplaced: [] };

  const rand = random(seed);
  const byId = new Map(words.map((w) => [w.id, w]));
  const byLength = [...words].sort((a, b) => letters(b.answer).length - letters(a.answer).length);
  let best = null;

  for (let n = 0; n < ATTEMPTS; n++) {
    // The first attempt is longest-first, the usual best start; the rest vary it.
    const order = n === 0 ? byLength : shuffled(byLength, rand);
    const { board: placed, unplaced } = attempt(order);
    const board = densify(placed, byId);
    const b = board.bounds;
    const result = {
      board, unplaced, crossings: board.crossings,
      area: (b.bottom - b.top + 1) * (b.right - b.left + 1),
    };
    if (better(result, best)) best = result;
  }

  const { top, bottom, left, right } = best.board.bounds;
  const order = new Map(words.map((w, i) => [w.id, i]));
  const unplacedIds = new Set(best.unplaced.map((w) => w.id));

  return {
    rows: bottom - top + 1,
    cols: right - left + 1,
    // How many letters two words share: the panel shows it, the app gains from it.
    crossings: best.crossings,
    placements: best.board.placements
      .map((p) => ({ ...p, row: p.row - top, col: p.col - left }))
      .sort((a, b) => order.get(a.id) - order.get(b.id)),
    unplaced: words.filter((w) => unplacedIds.has(w.id)).map((w) => w.id),
  };
}
