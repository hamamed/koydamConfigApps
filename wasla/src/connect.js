/**
 * وصّل الحروف: a picture, and the words that belong to it spelled out of one
 * board of letters.
 *
 * The board is those words' letters and nothing else — every box belongs to
 * exactly one word, so the boxes add up to the board and none is filler. A
 * letter may be taken from anywhere, in any order, and a word found keeps its
 * boxes: they take its colour and stay on the board while the rest are looked
 * for. Because the board is exactly the words' letters, taking whichever copy
 * of a letter comes to hand never strands the words left.
 *
 * The pictures are the ones written in the panel — the same ones فقاعات
 * الكلمات is played on — and every one of them carries eight words. Eight
 * words are more letters than a square holds, so the board is as many rows of
 * five or six as they need, and the last row may end short: the boxes it does
 * not need are simply not there.
 */

import { foldForPlay, letters, normalizeAnswer } from './arabic.js';
import { parseDay } from './daily.js';
import { random, shuffled } from './wordsearch.js';

/** How many words a board asks for, and the fewest it is worth building at. */
export const CONNECT_WORDS = Object.freeze([4, 8]);
/** A word short enough to share a board, long enough to be worth finding. */
export const CONNECT_LETTERS = Object.freeze([3, 7]);
/** The widths a phone holds, and the most rows it can show at once. */
export const CONNECT_COLS = Object.freeze([5, 6]);
export const CONNECT_MAX_ROWS = 8;
/** What a picture board asks, since its words carry no clue of their own. */
export const PICTURE_ASK = 'ما الذي في الصورة؟';

const ARABIC_WORD = /^[ء-غف-ي]+$/u;

/**
 * A walk that visits every box once, each step to the box beside it (no
 * diagonals), or null when no walk was found. Boxes in `blocked` — the tail of
 * a last row the words do not fill — are not part of the board.
 */
export function walk(rows, cols, rand, blocked = new Set()) {
  const boxes = rows * cols - blocked.size;
  const starts = shuffled(
    Array.from({ length: rows * cols }, (_, index) => [Math.floor(index / cols), index % cols])
      .filter(([row, col]) => !blocked.has(`${row},${col}`)),
    rand,
  );

  for (const start of starts) {
    const seen = Array.from({ length: rows }, () => new Array(cols).fill(false));
    const path = [];
    // Room enough to find a walk from this box, and to give up on the boxes a
    // walk cannot start from: the next start is tried rather than the whole
    // board refused.
    let steps = 0;

    const from = ([row, col]) => {
      seen[row][col] = true;
      path.push([row, col]);
      if (path.length === boxes) return true;
      const next = shuffled([[row - 1, col], [row + 1, col], [row, col - 1], [row, col + 1]], rand)
        .filter(([r, c]) => r >= 0 && r < rows && c >= 0 && c < cols && !seen[r][c] && !blocked.has(`${r},${c}`));
      for (const box of next) {
        if (++steps > 40_000) return false;
        if (from(box)) return true;
      }
      seen[row][col] = false;
      path.pop();
      return false;
    };

    if (from(start)) return path;
  }
  return null;
}

/**
 * The shape that holds `total` letters: the fewest rows, since a phone shows
 * the board all at once, and of those the one leaving the fewest empty boxes.
 */
export function shapeFor(total) {
  const shapes = CONNECT_COLS
    .map((cols) => ({ cols, rows: Math.ceil(total / cols) }))
    .filter(({ rows }) => rows >= 2 && rows <= CONNECT_MAX_ROWS);
  if (!shapes.length) return null;
  return shapes.reduce((best, shape) => {
    if (shape.rows !== best.rows) return shape.rows < best.rows ? shape : best;
    return shape.rows * shape.cols < best.rows * best.cols ? shape : best;
  });
}

/**
 * Writes the words into a board: each one along its own run of a walk over it,
 * so its letters sit side by side and its run is the block that takes its
 * colour once it is found. `{ rows, cols, words }` or null.
 */
export function layout(chosen, rand) {
  const total = chosen.reduce((sum, entry) => sum + letters(entry.word).length, 0);
  const shape = shapeFor(total);
  if (!shape) return null;

  const { rows, cols } = shape;
  // The boxes the words do not reach are the tail of the last row; the board
  // simply has no box there.
  const blocked = new Set();
  for (let box = total; box < rows * cols; box++) blocked.add(`${Math.floor(box / cols)},${box % cols}`);

  const path = walk(rows, cols, rand, blocked);
  if (!path) return null;

  // The runs are handed out in a mixed order, so where a block sits on the
  // board says nothing about which word it is.
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(' '));
  const runs = new Map();
  let step = 0;
  for (const entry of shuffled(chosen, rand)) {
    const run = [];
    for (const letter of letters(entry.word)) {
      const [row, col] = path[step++];
      grid[row][col] = letter;
      run.push([row, col]);
    }
    runs.set(entry.id, run);
  }

  return {
    rows: grid.map((row) => row.join('')),
    cols,
    words: chosen
      .map((entry) => ({
        id: entry.id,
        word: entry.word,
        display: entry.display,
        clue: entry.clue ?? '',
        emoji: entry.emoji ?? '',
        // Where its letters sit, in the order they are written.
        cells: runs.get(entry.id),
      }))
      .sort((a, b) => letters(a.word).length - letters(b.word).length || a.id - b.id),
  };
}

/** The words of a picture that a board can ask for: short enough to spell out. */
export function pictureWords(round) {
  const seen = new Set();
  return (round?.words ?? [])
    .map((raw, index) => ({
      id: 800_000 + index,
      word: foldForPlay(normalizeAnswer(raw)),
      display: normalizeAnswer(raw),
      clue: '',
    }))
    .filter((entry) => {
      const size = letters(entry.word).length;
      if (!ARABIC_WORD.test(entry.word) || seen.has(entry.word)) return false;
      if (size < CONNECT_LETTERS[0] || size > CONNECT_LETTERS[1]) return false;
      seen.add(entry.word);
      return true;
    });
}

/**
 * A board from one picture: the picture asks, and its words are the answers.
 * Up to eight of them — the whole picture — and the longest go first when
 * there are more than a board can hold.
 */
export function buildPictureConnect(round, seed) {
  const pool = pictureWords(round);
  if (pool.length < CONNECT_WORDS[0]) return null;

  const rand = random(seed);
  let chosen = shuffled(pool, rand).slice(0, CONNECT_WORDS[1]);
  // A board of eight long words can be taller than a phone; the shortest of
  // them step aside until what is left fits.
  while (chosen.length >= CONNECT_WORDS[0]) {
    const board = layout(chosen, random(seed + chosen.length));
    if (board) {
      return {
        ...board,
        theme: String(round.title ?? '').trim(),
        ask: PICTURE_ASK,
        image: round.image ?? null,
      };
    }
    chosen = chosen.slice(0, -1);
  }
  return null;
}

/**
 * The board a date plays: the picture of that date, and its words. A date with
 * no picture published has no board, and the day's ladder is one rung shorter.
 */
export function connectForDate(_questions, date, { nonce = 0, pictures = null } = {}) {
  const parsed = parseDay(date);
  if (!parsed) return null;

  const step = Number.isFinite(Number(nonce)) ? Math.trunc(Number(nonce)) : 0;
  const seed = (Math.imul(parsed.day + step + 1, 2654435761) ^ Math.imul(step + 5, 40503)) >>> 0;
  // Its own turn through the pictures, so the day's two picture games are not
  // played on the same one.
  return buildPictureConnect(pictures?.forDate?.(parsed.date, step + 3), seed);
}
