/**
 * وصّل الحروف: one question, and its answer spread over every box of the board.
 *
 * The board is exactly as big as the answer is long — «الدار البيضاء» is twelve
 * letters, so the board is 3×4 — and the answer is written along a path that
 * visits every box once. Nothing is filler: every letter on the board is a
 * letter of the answer, in an order only the answer knows.
 *
 * The question comes three ways, and the app shows it in the same card the main
 * game asks its questions in:
 *
 *   نص      a question with a clue to read: «أكبر مدن المغرب»
 *   إيموجي  an emoji question, where the emoji is the whole question: 🇪🇬🐪
 *   مثل     a proverb from the قوافي list, with its emoji over it: the board is
 *           the proverb itself
 *
 * The player reads the question, works out the answer, then drags a finger
 * through it from its first letter to its last.
 */

import { foldForPlay, letters, normalizeAnswer } from './arabic.js';
import { parseDay } from './daily.js';
import { random, shuffled } from './wordsearch.js';

/** A board is at least this many boxes, and at most this many. */
export const CONNECT_LETTERS = Object.freeze([8, 20]);
/** Neither side of the board may be thinner than this, or longer than this. */
export const CONNECT_SIDES = Object.freeze([2, 5]);

const ARABIC_WORD = /^[ء-غف-ي]+$/u;

/**
 * The board an answer of `count` letters makes: the pair of sides closest to a
 * square, inside `CONNECT_SIDES`. Null when the count cannot make one — 11 and
 * 13 are prime, and 14 would need a side of seven.
 */
export function boardShape(count) {
  let best = null;
  for (let rows = CONNECT_SIDES[0]; rows <= CONNECT_SIDES[1]; rows++) {
    if (count % rows) continue;
    const cols = count / rows;
    if (cols < CONNECT_SIDES[0] || cols > CONNECT_SIDES[1]) continue;
    const shape = { rows, cols };
    if (!best || Math.abs(shape.rows - shape.cols) < Math.abs(best.rows - best.cols)) best = shape;
  }
  return best;
}

/** The cells touching one, inside the board, in a shuffled order. */
function neighbours(cell, rows, cols, rand) {
  const [row, col] = cell;
  const around = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const r = row + dr;
      const c = col + dc;
      if (r >= 0 && r < rows && c >= 0 && c < cols) around.push([r, c]);
    }
  }
  return shuffled(around, rand);
}

/**
 * A path that visits every box exactly once, each step touching the one before
 * it. Null when none was found, which a board this small does not do.
 */
export function snake(rows, cols, rand) {
  const total = rows * cols;
  const starts = shuffled(Array.from({ length: total }, (_, i) => [Math.floor(i / cols), i % cols]), rand);
  for (const start of starts) {
    const path = [start];
    const seen = new Set([String(start)]);
    const walk = () => {
      if (path.length === total) return true;
      for (const next of neighbours(path.at(-1), rows, cols, rand)) {
        const key = String(next);
        if (seen.has(key)) continue;
        seen.add(key);
        path.push(next);
        if (walk()) return true;
        path.pop();
        seen.delete(key);
      }
      return false;
    };
    if (walk()) return path;
  }
  return null;
}

/**
 * The board for one question, or null when its answer cannot fill one.
 * `path` is the order the letters are read in: the answer, box by box.
 */
export function buildConnect(entry, seed) {
  if (!entry) return null;
  const display = normalizeAnswer(entry.answer ?? entry.word ?? '');
  const answer = foldForPlay(display);
  const list = letters(answer);
  if (!ARABIC_WORD.test(answer)) return null;
  if (list.length < CONNECT_LETTERS[0] || list.length > CONNECT_LETTERS[1]) return null;

  const shape = boardShape(list.length);
  if (!shape) return null;

  const rand = random(seed);
  const path = snake(shape.rows, shape.cols, rand);
  if (!path) return null;

  const grid = Array.from({ length: shape.rows }, () => Array(shape.cols).fill(''));
  path.forEach(([row, col], index) => {
    grid[row][col] = list[index];
  });

  return {
    rows: grid.map((row) => row.join('')),
    cols: shape.cols,
    path,
    answer,
    display,
    clue: String(entry.clue ?? '').trim(),
    emoji: String(entry.emoji ?? '').trim(),
    title: String(entry.title ?? '').trim(),
  };
}

/** True when the letters of `answer` can fill a board. */
const fits = (answer) => {
  const count = letters(answer).length;
  return ARABIC_WORD.test(answer) && count >= CONNECT_LETTERS[0]
    && count <= CONNECT_LETTERS[1] && Boolean(boardShape(count));
};

/**
 * Every question that can make a board: its answer fills one, and it asks
 * something — a clue to read, or emoji to read instead. A picture question is
 * left out: its picture is the question, and «علم أي دولة» alone asks nothing.
 */
export function connectPool(questions) {
  const seen = new Set();
  const pool = [];
  for (const row of questions) {
    const answer = foldForPlay(normalizeAnswer(row.answer ?? ''));
    const clue = String(row.clue ?? '').trim();
    const emoji = String(row.emoji ?? '').trim();
    if ((!clue && !emoji) || seen.has(answer) || !fits(answer)) continue;
    seen.add(answer);
    pool.push({
      id: row.id,
      answer: normalizeAnswer(row.answer),
      clue,
      emoji,
      title: String(row.title ?? '').trim(),
    });
  }
  return pool;
}

/**
 * The proverbs that can make a board: the whole proverb is the answer, and its
 * emoji is the question. «الصبر مفتاح الفرج» is fifteen letters, so 3×5.
 */
export function proverbPool(riddles) {
  const seen = new Set();
  const pool = [];
  (riddles ?? []).forEach((riddle, index) => {
    const phrase = [riddle.before, riddle.answer, riddle.after].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const answer = foldForPlay(normalizeAnswer(phrase));
    if (!phrase || seen.has(answer) || !fits(answer)) return;
    seen.add(answer);
    pool.push({
      // Far above any question id, so the two pools never collide.
      id: 900_000 + index,
      answer: phrase,
      clue: String(riddle.emoji ?? '').trim() ? '' : 'أكمل المثل',
      emoji: String(riddle.emoji ?? '').trim(),
      title: String(riddle.source ?? '').trim() || 'مثل عربي',
    });
  });
  return pool;
}

/**
 * The board a date plays: one question, taken by rotation so the same date
 * always asks the same one. A question whose answer will not lay out passes the
 * day to the next.
 */
export function connectForDate(questions, date, { nonce = 0, riddles = [] } = {}) {
  const parsed = parseDay(date);
  if (!parsed) return null;
  // The proverbs come first in the list, so every few days one comes round.
  const pool = [...proverbPool(riddles), ...connectPool(questions)];
  if (!pool.length) return null;

  const step = Number.isFinite(Number(nonce)) ? Math.trunc(Number(nonce)) : 0;
  const day = parsed.day + step;
  const list = shuffled([...pool].sort((a, b) => a.id - b.id), random(0x517e));


  for (let attempt = 0; attempt < Math.min(list.length, 40); attempt++) {
    const entry = list[(((day + attempt) % list.length) + list.length) % list.length];
    const seed = (Math.imul(day + 1, 2654435761) ^ Math.imul(step + attempt + 5, 40503)) >>> 0;
    const board = buildConnect(entry, seed);
    if (board) return board;
  }
  return null;
}
