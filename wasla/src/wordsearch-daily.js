/**
 * The daily word search: one board per calendar date, the same for everyone.
 *
 * Themes come from question titles. A title's words are its questions'
 * answers in their played form (contract §1), 3–8 letters, each once; a word
 * readable inside a longer one (نمر in نمرة) or as the reverse of another
 * (رمن / نمر) is left out, because it could be found in two places. A title
 * with at least MIN_THEME_WORDS such words is a theme, unless the panel
 * excluded it.
 *
 * Nothing is stored per date. The theme is the eligible themes, sorted by
 * title, indexed by days since 1970-01-01; the board size follows the weekday;
 * the words and the board come from a seed made of the date. Editing a theme's
 * questions therefore changes the boards of the dates that use it, today's
 * included — like the automatic daily crossword.
 */

import { foldForPlay, letters } from './arabic.js';
import { parseDay } from './daily.js';
import { buildBoard, MAX_SIZE, random, shuffled } from './wordsearch.js';

export const MIN_WORD_LETTERS = 3;
export const MAX_WORD_LETTERS = 8;
export const MIN_THEME_WORDS = 6;
export const MAX_BOARD_WORDS = 10;
/** Themes this close to eligible are listed in the panel as needing more questions. */
export const CLOSE_THEME_WORDS = 4;

/**
 * Board size by weekday, Monday first: 7, 7, 8, 8, 9, 9, 10 — small early in
 * the week, largest on Sunday. Indexed by `SIZE_BY_WEEKDAY[(day + 3) % 7]`,
 * since 1970-01-01 (day 0) was a Thursday.
 */
export const SIZE_BY_WEEKDAY = Object.freeze([7, 7, 8, 8, 9, 9, 10]);
export const WEEKDAY_NAMES = Object.freeze(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);

/** How many words a board of each size aims for, [fewest, most]; the date picks within. */
const WORDS_BY_SIZE = Object.freeze({ 7: [6, 7], 8: [6, 8], 9: [7, 9], 10: [8, 10] });
/** Rounds of swapping a word that did not fit for one that was left over. */
const REFILL_ROUNDS = 5;

/** 0 = Monday … 6 = Sunday, for a day number since the epoch. */
export const weekdayOf = (day) => (day + 3) % 7;
export const sizeForDay = (day) => SIZE_BY_WEEKDAY[weekdayOf(day)];

const reversed = (word) => [...word].reverse().join('');

/**
 * The usable words of one title, from its questions in id order: `{ words, skipped }`,
 * each skipped one with a reason (length, duplicate, contained).
 */
export function themeWords(questions) {
  const seen = new Set();
  const candidates = [];
  const skipped = [];
  for (const q of questions) {
    const word = foldForPlay(q.answer);
    const count = letters(word).length;
    const entry = { id: q.id, word, display: q.answer };
    if (count < MIN_WORD_LETTERS || count > MAX_WORD_LETTERS) skipped.push({ ...entry, reason: 'length' });
    else if (seen.has(word)) skipped.push({ ...entry, reason: 'duplicate' });
    else {
      seen.add(word);
      candidates.push({ ...entry, count });
    }
  }
  // Longest first, so a word is only ever checked against words at least as long.
  const kept = [];
  for (const entry of [...candidates].sort((a, b) => b.count - a.count || a.id - b.id)) {
    const hidden = kept.some((k) => k.word.includes(entry.word) || k.word.includes(reversed(entry.word)));
    if (hidden) skipped.push({ id: entry.id, word: entry.word, display: entry.display, reason: 'contained' });
    else kept.push(entry);
  }
  const words = kept.sort((a, b) => a.id - b.id).map(({ id, word, display }) => ({ id, word, display }));
  return { words, skipped: skipped.sort((a, b) => a.id - b.id) };
}

/** Code-point order: the same on every machine, whatever its locale. */
const byTitle = (a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);

/** A seed from the date and what is being tried on it. */
const seedOf = (day, size, attempt) => (Math.imul(day, 2654435761) ^ Math.imul(size * 31 + attempt, 40503)) >>> 0;

/** A board for one theme at one size, or null when fewer than MIN_THEME_WORDS fit. */
export function boardForTheme(theme, size, seed) {
  const pool = theme.words.filter((w) => letters(w.word).length <= size);
  if (pool.length < MIN_THEME_WORDS) return null;

  const rand = random(seed);
  const order = shuffled(pool, rand);
  const [fewest, most] = WORDS_BY_SIZE[size];
  const target = Math.min(pool.length, MAX_BOARD_WORDS, fewest + Math.floor(rand() * (most - fewest + 1)));
  let picked = order.slice(0, target);
  let spare = order.slice(target);

  let board = buildBoard({ words: picked, size, seed });
  for (let round = 0; round < REFILL_ROUNDS && board.dropped.length && spare.length; round++) {
    const droppedIds = new Set(board.dropped.map((d) => d.id));
    picked = [...picked.filter((w) => !droppedIds.has(w.id)), ...spare.slice(0, droppedIds.size)];
    spare = spare.slice(droppedIds.size);
    board = buildBoard({ words: picked, size, seed });
  }
  return board.words.length >= MIN_THEME_WORDS ? board : null;
}

export function createWordSearch(db, { appConfig }) {
  const excludedTitles = () => new Set(db.prepare('SELECT title FROM wordsearch_excluded_titles').pluck().all());

  /** Every titled group of questions: `{ title, words, skipped, excluded, eligible, missing }`, by title. */
  function themes() {
    const groups = new Map();
    const rows = db.prepare(`SELECT id, answer, trim(title) AS title FROM questions
      WHERE trim(IFNULL(title, '')) <> '' ORDER BY id`).all();
    for (const row of rows) groups.set(row.title, [...(groups.get(row.title) ?? []), row]);
    const excluded = excludedTitles();
    return [...groups].map(([title, questions]) => {
      const { words, skipped } = themeWords(questions);
      return {
        title,
        questionCount: questions.length,
        words,
        skipped,
        excluded: excluded.has(title),
        eligible: words.length >= MIN_THEME_WORDS,
        missing: Math.max(0, MIN_THEME_WORDS - words.length),
      };
    }).sort(byTitle);
  }

  /** The themes a date can use: eligible, not excluded, by title. */
  const playable = () => themes().filter((t) => t.eligible && !t.excluded);

  /**
   * The board for a date — `{ date, theme, size, coins, rows, words }` as the
   * API sends it — or null for a bad date or when no theme can make one.
   *
   * The weekday's size comes first: every theme is tried at that size,
   * starting from the date's own, before any is tried a size larger. A theme
   * whose words are too long for a small board so passes the day to the next.
   */
  function forDate(date, list = playable()) {
    const parsed = parseDay(date);
    if (!parsed || !list.length) return null;
    const scheduled = sizeForDay(parsed.day);
    for (let size = scheduled; size <= MAX_SIZE; size++) {
      for (let step = 0; step < list.length; step++) {
        const theme = list[(parsed.day + step) % list.length];
        const board = boardForTheme(theme, size, seedOf(parsed.day, size, step));
        if (!board) continue;
        return {
          date: parsed.date,
          theme: theme.title,
          size: board.size,
          coins: appConfig.get().dailyPuzzleCoins,
          rows: board.rows,
          words: board.words,
        };
      }
    }
    return null;
  }

  /** Keeps a title out of (or lets it back into) the daily word search. */
  function setExcluded(title, excluded) {
    const clean = String(title ?? '').trim();
    if (!clean) return { error: 'Choose a theme.' };
    if (excluded) {
      db.prepare('INSERT INTO wordsearch_excluded_titles (title) VALUES (?) ON CONFLICT(title) DO NOTHING').run(clean);
    } else {
      db.prepare('DELETE FROM wordsearch_excluded_titles WHERE title = ?').run(clean);
    }
    return {};
  }

  return { themes, playable, forDate, setExcluded };
}
