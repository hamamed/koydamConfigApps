/**
 * وصّل الحروف: a board of letters, and several questions whose answers are
 * spelled out of it by drawing a line from letter to letter.
 *
 * The board is the answers' own letters, pooled: every box holds a letter some
 * answer needs, and a letter serves as many answers as need it. The line may go
 * anywhere — a letter does not have to touch the one before it — so the player
 * picks whichever letters they want, in whichever order, and each answer found
 * keeps its own line on the board.
 *
 * The questions come from one title of the bank, so a board is about one thing.
 */

import { foldForPlay, letters, normalizeAnswer } from './arabic.js';
import { parseDay } from './daily.js';
import { random, shuffled } from './wordsearch.js';

/** The board: four rows of five, which a phone holds comfortably. */
export const CONNECT_ROWS = 4;
export const CONNECT_COLS = 5;
export const CONNECT_BOXES = CONNECT_ROWS * CONNECT_COLS;
/** How many answers a board asks for, and the fewest it is worth building at. */
export const CONNECT_WORDS = 5;
export const CONNECT_MIN_WORDS = 3;
/** An answer short enough to pool with others, long enough to be worth drawing. */
export const CONNECT_LETTERS = Object.freeze([3, 7]);

const ARABIC_WORD = /^[ء-غف-ي]+$/u;

/** How many of each letter a word needs. */
function counts(word) {
  const need = new Map();
  for (const letter of letters(word)) need.set(letter, (need.get(letter) ?? 0) + 1);
  return need;
}

/**
 * The letters a set of words needs between them: the most any one of them wants
 * of each letter, so every word can be spelled from the pool on its own.
 */
export function poolFor(words) {
  const most = new Map();
  for (const word of words) {
    for (const [letter, count] of counts(word)) {
      most.set(letter, Math.max(most.get(letter) ?? 0, count));
    }
  }
  return [...most].flatMap(([letter, count]) => Array(count).fill(letter));
}

/**
 * A board from a title's answers: `{ rows, cols, words }`, or null when the
 * title cannot fill one. Answers are added while their letters still fit the
 * board, and the boxes left over take a second copy of letters already there —
 * so no box is filler, and none is wasted either.
 */
export function buildConnect(pool, seed, { rows = CONNECT_ROWS, cols = CONNECT_COLS, count = CONNECT_WORDS } = {}) {
  const rand = random(seed);
  const boxes = rows * cols;
  const chosen = [];
  let need = [];

  for (const entry of shuffled(pool, rand)) {
    if (chosen.length === count) break;
    const size = letters(entry.word).length;
    if (size < CONNECT_LETTERS[0] || size > CONNECT_LETTERS[1]) continue;
    if (chosen.some((other) => other.word === entry.word)) continue;
    const grown = poolFor([...chosen.map((other) => other.word), entry.word]);
    if (grown.length > boxes) continue;
    chosen.push(entry);
    need = grown;
  }
  if (chosen.length < CONNECT_MIN_WORDS) return null;

  // The boxes the answers do not need take another copy of a letter they do.
  const filled = [...need];
  while (filled.length < boxes) filled.push(need[Math.floor(rand() * need.length)]);

  const mixed = shuffled(filled, rand);
  const grid = Array.from({ length: rows }, (_, row) => mixed.slice(row * cols, row * cols + cols).join(''));

  return {
    rows: grid,
    cols,
    words: chosen
      .map((entry) => ({
        id: entry.id, word: entry.word, display: entry.display, clue: entry.clue, emoji: entry.emoji ?? '',
      }))
      .sort((a, b) => letters(a.word).length - letters(b.word).length || a.id - b.id),
  };
}

/** Every question that can go on a board: an answer to spell, and a clue to read. */
export function connectPool(questions) {
  const seen = new Set();
  const pool = [];
  for (const row of questions) {
    const word = foldForPlay(normalizeAnswer(row.answer ?? ''));
    const clue = String(row.clue ?? '').trim();
    const size = letters(word).length;
    if (!clue || seen.has(word) || !ARABIC_WORD.test(word)) continue;
    if (size < CONNECT_LETTERS[0] || size > CONNECT_LETTERS[1]) continue;
    seen.add(word);
    pool.push({
      id: row.id,
      word,
      display: normalizeAnswer(row.answer),
      clue,
      emoji: String(row.emoji ?? '').trim(),
      title: String(row.title ?? '').trim(),
    });
  }
  return pool;
}

/**
 * The board a date plays: one title's questions, taken by rotation so the same
 * date always asks the same ones. A title whose letters will not pool into a
 * board passes the day to the next.
 */
export function connectForDate(questions, date, { nonce = 0 } = {}) {
  const parsed = parseDay(date);
  if (!parsed) return null;
  const pool = connectPool(questions);
  if (!pool.length) return null;

  const step = Number.isFinite(Number(nonce)) ? Math.trunc(Number(nonce)) : 0;
  const day = parsed.day + step;

  const byTitle = new Map();
  for (const entry of pool) {
    if (!entry.title) continue;
    byTitle.set(entry.title, [...byTitle.get(entry.title) ?? [], entry]);
  }
  const titles = [...byTitle.entries()]
    .filter(([, words]) => words.length >= CONNECT_WORDS)
    .sort(([a], [b]) => (a < b ? -1 : 1));

  const tries = titles.length ? titles.length : 1;
  for (let attempt = 0; attempt < Math.min(tries, 30); attempt++) {
    const seed = (Math.imul(day + 1, 2654435761) ^ Math.imul(step + attempt + 5, 40503)) >>> 0;
    if (!titles.length) {
      const board = buildConnect(pool, seed);
      return board ? { ...board, theme: '' } : null;
    }
    const [title, words] = titles[(((day + attempt) % titles.length) + titles.length) % titles.length];
    const board = buildConnect(words, seed);
    if (board) return { ...board, theme: title };
  }
  return null;
}
