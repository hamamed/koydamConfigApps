/**
 * وصّل الحروف: a board of letters, and several questions whose answers are
 * spelled out of it letter by letter.
 *
 * The board is the answers' letters and nothing else — every box belongs to
 * exactly one answer, so the boxes add up to the board and none is filler. A
 * letter may be taken from anywhere, in any order, and an answer found keeps
 * its boxes: they take its colour and stay on the board while the rest are
 * looked for.
 *
 * Because the board is exactly the answers' letters, taking whichever copy of a
 * letter comes to hand never strands the answers left — what remains is always
 * precisely what they need.
 *
 * The questions come from one title of the bank, so a board is about one thing.
 */

import { foldForPlay, letters, normalizeAnswer } from './arabic.js';
import { parseDay } from './daily.js';
import { random, shuffled } from './wordsearch.js';

/** The boards a phone holds comfortably, biggest first: `[rows, cols]`. */
export const CONNECT_SHAPES = Object.freeze([[4, 5], [4, 4], [3, 5], [3, 4]]);
/** How many answers a board holds, fewest and most. */
export const CONNECT_WORDS = Object.freeze([3, 6]);
/** An answer short enough to share a board, long enough to be worth finding. */
export const CONNECT_LETTERS = Object.freeze([3, 7]);
/** How many answers the search looks at; a title with more is sampled. */
const SEARCH_WIDTH = 40;

const ARABIC_WORD = /^[ء-غف-ي]+$/u;

/**
 * Answers whose letters add up to exactly `total`, between three and six of
 * them — the board is their letters and nothing besides, so the sum has to be
 * exact. The entries are taken in the order given, so shuffling them first is
 * what makes one day's board differ from another's.
 */
export function chooseWords(entries, total, [fewest, most] = CONNECT_WORDS) {
  const search = entries.slice(0, SEARCH_WIDTH);

  const pick = (from, left, chosen) => {
    if (left === 0) return chosen.length >= fewest ? chosen : null;
    if (chosen.length === most) return null;
    for (let index = from; index < search.length; index++) {
      const entry = search[index];
      if (entry.size > left) continue;
      if (chosen.some((other) => other.word === entry.word)) continue;
      const found = pick(index + 1, left - entry.size, [...chosen, entry]);
      if (found) return found;
    }
    return null;
  };

  return pick(0, total, []);
}

/**
 * A board from a title's answers: `{ rows, cols, words }`, or null when no
 * board size can be filled exactly by three to six of them.
 */
export function buildConnect(pool, seed, { shapes = CONNECT_SHAPES } = {}) {
  const rand = random(seed);
  const entries = shuffled(
    pool
      .map((entry) => ({ ...entry, size: letters(entry.word).length }))
      .filter((entry) => entry.size >= CONNECT_LETTERS[0] && entry.size <= CONNECT_LETTERS[1]),
    rand,
  );
  if (!entries.length) return null;

  for (const [rows, cols] of shapes) {
    const chosen = chooseWords(entries, rows * cols);
    if (!chosen) continue;

    const mixed = shuffled(chosen.flatMap((entry) => letters(entry.word)), rand);
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
  return null;
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
 * date always asks the same ones. A title whose answers will not fill a board
 * passes the day to the next.
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
    .filter(([, words]) => words.length >= CONNECT_WORDS[0])
    .sort(([a], [b]) => (a < b ? -1 : 1));

  for (let attempt = 0; attempt < Math.min(Math.max(titles.length, 1), 30); attempt++) {
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
