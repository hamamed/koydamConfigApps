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
 * A board asks in one of three ways. Most days its questions come from one
 * title of the bank, each answer with its own clue. Some days the whole board
 * is one picture, and the answers are what is in it — a sun: حار، صيف، ضوء،
 * نجم. Some days it is a proverb in emoji, and the answers are its words.
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

/** A proverb is written out whole, so its board may be smaller and narrower. */
export const PROVERB_SHAPES = Object.freeze([
  [2, 3], [2, 4], [3, 3], [2, 5], [3, 4], [2, 7], [3, 5], [4, 4], [3, 6], [4, 5], [3, 7], [4, 6], [5, 5],
]);
/** Its words are what they are: «من» is two letters and still a word. */
export const PROVERB_LETTERS = Object.freeze([2, 7]);
export const PROVERB_WORDS = Object.freeze([2, 7]);
/** What a board asks when its answers have no clue of their own. */
export const PICTURE_ASK = 'ما الذي في الصورة؟';
export const PROVERB_ASK = 'ما المثل؟';
/** How the days share themselves out between the three kinds of board. */
export const FLAVOURS = Object.freeze(['bank', 'picture', 'bank', 'proverb']);

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
 * A walk that visits every box once, each step to the box beside it (no
 * diagonals), or null when this shuffle of starts and turns does not find one.
 * Cutting the walk into runs is what puts each answer's letters side by side.
 */
export function walk(rows, cols, rand) {
  const boxes = rows * cols;
  const starts = shuffled(
    Array.from({ length: boxes }, (_, index) => [Math.floor(index / cols), index % cols]),
    rand,
  );

  for (const start of starts) {
    const seen = Array.from({ length: rows }, () => new Array(cols).fill(false));
    const path = [];
    // Room enough to find a walk from this box, and to give up on the boxes a
    // walk cannot start from: a board with an odd number of boxes has half of
    // them, so the next start is tried rather than the whole board refused.
    let steps = 0;

    const from = ([row, col]) => {
      seen[row][col] = true;
      path.push([row, col]);
      if (path.length === boxes) return true;
      const next = shuffled([[row - 1, col], [row + 1, col], [row, col - 1], [row, col + 1]], rand)
        .filter(([r, c]) => r >= 0 && r < rows && c >= 0 && c < cols && !seen[r][c]);
      for (const box of next) {
        if (++steps > 30_000) return false;
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
 * Writes the chosen answers into a board: each one along its own run of a walk
 * over it, so its letters sit side by side and its run is the block that takes
 * its colour once it is found.
 */
export function layout(chosen, rows, cols, rand) {
  const path = walk(rows, cols, rand);
  if (!path) return null;

  // The runs are handed out in a mixed order, so where a block sits on the
  // board says nothing about which question it answers.
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(''));
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

/**
 * A board from a title's answers: `{ rows, cols, words }`, or null when no
 * board size can be filled exactly by three to six of them.
 *
 * Each answer's letters are written along one run of a walk over the board, so
 * they sit beside one another rather than scattered: the run is where its
 * colour appears once it is found.
 */
export function buildConnect(pool, seed, { shapes = CONNECT_SHAPES, words = CONNECT_WORDS, sizes = CONNECT_LETTERS } = {}) {
  const rand = random(seed);
  const entries = shuffled(
    pool
      .map((entry) => ({ ...entry, size: letters(entry.word).length }))
      .filter((entry) => entry.size >= sizes[0] && entry.size <= sizes[1]),
    rand,
  );
  if (!entries.length) return null;

  for (const [rows, cols] of shapes) {
    const chosen = chooseWords(entries, rows * cols, words);
    if (!chosen) continue;
    const board = layout(chosen, rows, cols, rand);
    if (board) return board;
  }
  return null;
}


/**
 * A picture board: the picture is the question, and the answers are what is in
 * it — a sun: حار، صيف، ضوء، نجم. The words come from the picture rounds
 * written in the panel, the same ones فقاعات الكلمات is played on.
 */
export function buildPictureConnect(round, seed) {
  if (!round?.words?.length) return null;
  const pool = round.words.map((word, index) => ({
    id: 800_000 + index,
    word: foldForPlay(normalizeAnswer(word)),
    display: normalizeAnswer(word),
    clue: '',
  })).filter((entry) => ARABIC_WORD.test(entry.word));

  const board = buildConnect(pool, seed);
  return board && {
    ...board,
    theme: String(round.title ?? '').trim(),
    ask: PICTURE_ASK,
    image: round.image ?? null,
  };
}

/**
 * A proverb board: the emoji is the question and the proverb's own words are
 * the answers, so the board holds the whole saying and nothing else. A proverb
 * whose letters fill no board, or that has no emoji to ask with, makes none.
 */
export function buildProverbConnect(riddle, seed) {
  const emoji = String(riddle?.emoji ?? '').trim();
  if (!emoji) return null;

  const said = normalizeAnswer([riddle.before, riddle.answer, riddle.after].filter(Boolean).join(' '));
  const words = said.split(/\s+/).filter(Boolean).map((word, index) => ({
    id: 700_000 + index,
    word: foldForPlay(word),
    display: word,
    clue: '',
  }));
  if (!words.every((entry) => ARABIC_WORD.test(entry.word))) return null;
  if (words.length < PROVERB_WORDS[0] || words.length > PROVERB_WORDS[1]) return null;

  const total = words.reduce((sum, entry) => sum + letters(entry.word).length, 0);
  if (words.some((entry) => {
    const size = letters(entry.word).length;
    return size < PROVERB_LETTERS[0] || size > PROVERB_LETTERS[1];
  })) return null;

  const shape = PROVERB_SHAPES.find(([rows, cols]) => rows * cols === total);
  if (!shape) return null;

  const rand = random(seed);
  const board = layout(words.map((entry) => ({ ...entry })), shape[0], shape[1], rand);
  return board && {
    ...board,
    theme: String(riddle.source ?? '').trim(),
    ask: PROVERB_ASK,
    emoji,
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
 * date always asks the same ones. A title whose answers will not fill a board
 * passes the day to the next.
 */
export function connectForDate(questions, date, { nonce = 0, pictures = null, riddles = [] } = {}) {
  const parsed = parseDay(date);
  if (!parsed) return null;

  const step = Number.isFinite(Number(nonce)) ? Math.trunc(Number(nonce)) : 0;
  const day = parsed.day + step;
  const seedFor = (attempt) => (Math.imul(day + 1, 2654435761) ^ Math.imul(step + attempt + 5, 40503)) >>> 0;

  // The day's kind of board. A kind with nothing to show — no picture written
  // yet, no proverb whose letters fill a board — hands the day to the bank.
  switch (FLAVOURS[((day % FLAVOURS.length) + FLAVOURS.length) % FLAVOURS.length]) {
    case 'picture': {
      const board = buildPictureConnect(pictures?.forDate?.(parsed.date, step + 3), seedFor(1));
      if (board) return board;
      break;
    }
    case 'proverb': {
      const asked = riddles.filter((riddle) => String(riddle?.emoji ?? '').trim());
      for (let attempt = 0; attempt < asked.length; attempt++) {
        const riddle = asked[(((day + attempt) % asked.length) + asked.length) % asked.length];
        const board = buildProverbConnect(riddle, seedFor(attempt + 2));
        if (board) return board;
      }
      break;
    }
    default:
      break;
  }

  const pool = connectPool(questions);
  if (!pool.length) return null;

  const byTitle = new Map();
  for (const entry of pool) {
    if (!entry.title) continue;
    byTitle.set(entry.title, [...byTitle.get(entry.title) ?? [], entry]);
  }
  const titles = [...byTitle.entries()]
    .filter(([, words]) => words.length >= CONNECT_WORDS[0])
    .sort(([a], [b]) => (a < b ? -1 : 1));

  for (let attempt = 0; attempt < Math.min(Math.max(titles.length, 1), 30); attempt++) {
    const seed = seedFor(attempt);
    if (!titles.length) {
      const board = buildConnect(pool, seed);
      return board ? { ...board, theme: '', ask: '' } : null;
    }
    const [title, words] = titles[(((day + attempt) % titles.length) + titles.length) % titles.length];
    const board = buildConnect(words, seed);
    if (board) return { ...board, theme: title, ask: '' };
  }
  return null;
}
