/**
 * وصّل الحروف: a square of letters, and words found by dragging a finger from
 * one letter to the next — up, down, sideways or diagonally, and the path may
 * bend as often as it likes.
 *
 * A round comes one of two ways:
 *
 *   مثل    the words of a proverb from the قوافي list, with its emoji as the
 *          only clue; the proverb itself is the prize, shown once they are found
 *   بنك    the long answers of one of the question bank's titles, each with the
 *          question that asks for it — so the board reads like the main game:
 *          a clue, and its word hidden on the board
 *
 * Which of the two a date gets alternates, so the week that has a proverb has a
 * board of plain words the week after. Every word is planted along a path of
 * touching cells, which is what makes it findable, and the cells left over are
 * filled with letters weighted the way the word search fills its board.
 *
 * The board carries each word's path, so the app can light it up when it is
 * found and a paid help can show one.
 */

import { foldForPlay, letters, normalizeAnswer } from './arabic.js';
import { parseDay } from './daily.js';
import { FILLER_WEIGHTS, random, shuffled } from './wordsearch.js';

export const CONNECT_SIZE = 5;
export const CONNECT_WORDS = 6;
export const CONNECT_MIN_WORDS = 4;
/** A proverb is three or four words, so a proverb board may be shorter. */
export const CONNECT_MIN_PROVERB_WORDS = 3;
/** A word must be long enough to be worth dragging, short enough to fit a path. */
export const CONNECT_LETTERS = Object.freeze([3, 7]);
/** A board from the bank takes the long answers: a three-letter word is no drag. */
export const CONNECT_BANK_LETTERS = Object.freeze([4, 7]);

const FILLER = Object.entries(FILLER_WEIGHTS);
const FILLER_TOTAL = FILLER.reduce((sum, [, weight]) => sum + weight, 0);

/** A letter for an empty cell, by how often it turns up in Arabic. */
function filler(rand) {
  let ticket = rand() * FILLER_TOTAL;
  for (const [letter, weight] of FILLER) {
    ticket -= weight;
    if (ticket <= 0) return letter;
  }
  return 'ا';
}

/** The eight cells around one, inside the board. */
function neighbours(row, col, size) {
  const cells = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const r = row + dr;
      const c = col + dc;
      if (r >= 0 && r < size && c >= 0 && c < size) cells.push([r, c]);
    }
  }
  return cells;
}

/**
 * Plants one word along a path of touching cells, reusing a cell that already
 * holds the letter it needs. Returns the path, or null when it does not fit.
 * `grid` is left as it was when it fails.
 */
export function plant(grid, word, rand) {
  const size = grid.length;
  const wanted = letters(word);
  const written = [];

  const step = (index, path) => {
    if (index === wanted.length) return true;
    const options = index === 0
      ? shuffled(grid.flatMap((row, r) => row.map((_, c) => [r, c])), rand)
      : shuffled(neighbours(path[index - 1][0], path[index - 1][1], size), rand);
    for (const [r, c] of options) {
      if (path.some(([pr, pc]) => pr === r && pc === c)) continue;
      const cell = grid[r][c];
      if (cell !== null && cell !== wanted[index]) continue;
      const wasEmpty = cell === null;
      if (wasEmpty) {
        grid[r][c] = wanted[index];
        written.push([r, c]);
      }
      path.push([r, c]);
      if (step(index + 1, path)) return true;
      path.pop();
      if (wasEmpty) {
        grid[r][c] = null;
        written.pop();
      }
    }
    return false;
  };

  const path = [];
  if (step(0, path)) return path;
  for (const [r, c] of written) grid[r][c] = null;
  return null;
}

/**
 * A board from a list of words: `{ size, rows, words }`, or null when fewer
 * than `CONNECT_MIN_WORDS` could be planted. Longest first, so the short ones
 * fill the gaps the long ones leave.
 */
export function buildConnect(pool, seed, {
  size = CONNECT_SIZE, count = CONNECT_WORDS, range = CONNECT_LETTERS, minimum = CONNECT_MIN_WORDS,
} = {}) {
  const rand = random(seed);
  const grid = Array.from({ length: size }, () => Array(size).fill(null));
  const chosen = shuffled(pool, rand)
    .filter((entry) => {
      const length = letters(entry.word).length;
      return length >= range[0] && length <= Math.min(range[1], size * size);
    })
    // A word with its question first: the board reads like the main game.
    .sort((a, b) => Number(Boolean(b.clue)) - Number(Boolean(a.clue))
      || letters(b.word).length - letters(a.word).length);

  const words = [];
  const seen = new Set();
  for (const entry of chosen) {
    if (words.length === count) break;
    if (seen.has(entry.word)) continue;
    const path = plant(grid, entry.word, rand);
    if (!path) continue;
    seen.add(entry.word);
    words.push({ id: entry.id, word: entry.word, display: entry.display, clue: entry.clue ?? '', path });
  }
  if (words.length < minimum) return null;

  const rows = grid.map((row) => row.map((cell) => cell ?? filler(rand)).join(''));
  return {
    size,
    rows,
    words: words.sort((a, b) => letters(a.word).length - letters(b.word).length || a.id - b.id),
  };
}

/**
 * A board made of one proverb's words: «أطلب العلم ولو في الصين» plants العلم،
 * أطلب، الصين and leaves the particles out — they are too short to drag, and the
 * proverb is shown whole once the board is cleared.
 */
export function buildProverbConnect(riddle, seed) {
  if (!riddle) return null;
  const phrase = [riddle.before, riddle.answer, riddle.after].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const pool = [];
  const seen = new Set();
  phrase.split(/\s+/).forEach((raw, index) => {
    const display = normalizeAnswer(raw);
    const word = foldForPlay(display);
    if (letters(word).length < CONNECT_LETTERS[0] || seen.has(word)) return;
    seen.add(word);
    pool.push({ id: index + 1, word, display });
  });
  const board = buildConnect(pool, seed, { count: pool.length, minimum: CONNECT_MIN_PROVERB_WORDS });
  if (!board) return null;
  return {
    ...board,
    theme: String(riddle.source ?? '').trim() || 'مثل',
    emoji: String(riddle.emoji ?? '').trim(),
    phrase,
  };
}

/** Every answer the bank can offer this game: played form, once each. */
export function connectPool(questions) {
  const seen = new Set();
  const pool = [];
  for (const row of questions) {
    const word = foldForPlay(normalizeAnswer(row.answer ?? ''));
    if (!word || seen.has(word)) continue;
    seen.add(word);
    pool.push({
      id: row.id,
      word,
      display: normalizeAnswer(row.answer),
      clue: String(row.clue ?? '').trim(),
      title: String(row.title ?? '').trim(),
    });
  }
  return pool;
}

/**
 * The board a date plays. The words come from one title when that title has
 * enough of them — a board about one thing is nicer to read — and from the
 * whole bank when it does not.
 */
export function connectForDate(questions, date, { nonce = 0, riddles = [] } = {}) {
  const parsed = parseDay(date);
  if (!parsed) return null;
  const step = Number.isFinite(Number(nonce)) ? Math.trunc(Number(nonce)) : 0;
  const day = parsed.day + step;
  const seed = (Math.imul(day + 1, 2654435761) ^ Math.imul(step + 5, 40503)) >>> 0;

  // One week a proverb, the next a board of plain words.
  const wantsProverb = riddles.length > 0 && Math.floor(day / 7) % 2 === 0;
  if (wantsProverb) {
    const riddle = shuffled(riddles, random(0x9a0b))[((day % riddles.length) + riddles.length) % riddles.length];
    const board = buildProverbConnect(riddle, seed);
    if (board) return board;
  }

  const pool = connectPool(questions);
  if (!pool.length) return null;

  // One title's words first: the titles that have enough, in a fixed order.
  const byTitle = new Map();
  for (const entry of pool) {
    if (!entry.title) continue;
    byTitle.set(entry.title, [...byTitle.get(entry.title) ?? [], entry]);
  }
  const titles = [...byTitle.entries()]
    .filter(([, words]) => words.length >= CONNECT_WORDS * 2)
    .sort(([a], [b]) => (a < b ? -1 : 1));

  if (titles.length) {
    const [title, words] = titles[((day % titles.length) + titles.length) % titles.length];
    const board = buildConnect(words, seed, { range: CONNECT_BANK_LETTERS })
      ?? buildConnect(words, seed);
    if (board) return { ...board, theme: title, emoji: '', phrase: '' };
  }
  const board = buildConnect(pool, seed, { range: CONNECT_BANK_LETTERS }) ?? buildConnect(pool, seed);
  return board ? { ...board, theme: '', emoji: '', phrase: '' } : null;
}
