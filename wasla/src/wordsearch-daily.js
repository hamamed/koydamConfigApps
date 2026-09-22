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
 * This is the automatic board. The panel stores boards for planned dates
 * (src/wordsearch-schedule.js), and a stored board always wins. Here the
 * theme is the eligible themes, sorted by title, indexed by days since
 * 1970-01-01; the board size follows the weekday; the words and the board come
 * from a seed made of the date. Editing a theme's questions therefore changes
 * the automatic boards that use it — never a stored one.
 *
 * A date with a seasonal event (src/seasonal-events.js: Ramadan, the two Eids,
 * Fridays) tries that event's built-in theme first, at the weekday's size and
 * up, and only falls back to the rotation when it cannot make a board.
 */

import { foldForPlay, letters } from './arabic.js';
import { parseDay } from './daily.js';
import { kindForDay } from './daily-schedule.js';
import { EVENT_THEMES, eventFor, eventQuestions } from './seasonal-events.js';
import { buildBoard, MAX_SIZE, random, shuffled } from './wordsearch.js';

export const MIN_WORD_LETTERS = 3;
export const MAX_WORD_LETTERS = 8;
export const MIN_THEME_WORDS = 6;
export const MAX_BOARD_WORDS = 12;
/** Themes this close to eligible are listed in the panel as needing more questions. */
export const CLOSE_THEME_WORDS = 4;

/**
 * Board size by weekday, Monday first: 9, 9, 10, 10, 10, 10, 10 — the rung of
 * the ladder it stands on is a whole game, so even the smallest is big. Indexed by `SIZE_BY_WEEKDAY[(day + 3) % 7]`,
 * since 1970-01-01 (day 0) was a Thursday.
 *
 * The day the week hands the word search (contract §9) ignores the ramp and
 * takes the largest board there is: on its own day it is the whole puzzle.
 */
export const SIZE_BY_WEEKDAY = Object.freeze([9, 9, 10, 10, 10, 10, 10]);
export const WEEKDAY_NAMES = Object.freeze(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);

/** How many words a board of each size aims for, [fewest, most]; the date picks within. */
export const WORDS_BY_SIZE = Object.freeze({ 7: [6, 8], 8: [9, 10], 9: [11, 12], 10: [12, 12] });
/** Rounds of swapping a word that did not fit for one that was left over. */
const REFILL_ROUNDS = 5;

/** 0 = Monday … 6 = Sunday, for a day number since the epoch. */
export const weekdayOf = (day) => (day + 3) % 7;
export const sizeForDay = (day) => (kindForDay(day) === 'wordsearch' ? MAX_SIZE : SIZE_BY_WEEKDAY[weekdayOf(day)]);

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

const eventThemes = new Map();

/**
 * The built-in theme of a seasonal event kind — `{ title, words, skipped }`,
 * its words folded and filtered by themeWords like a title's answers — or
 * null for an unknown kind. Built once per kind.
 */
export function eventTheme(kind) {
  if (!EVENT_THEMES[kind]) return null;
  if (!eventThemes.has(kind)) eventThemes.set(kind, { title: EVENT_THEMES[kind].title, ...themeWords(eventQuestions(kind)) });
  return eventThemes.get(kind);
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
   * The automatic pick for a date — `{ theme, size, seed, board }` — or null
   * for a bad date or when no theme can make one.
   *
   * The weekday's size comes first: every theme is tried at that size,
   * starting from the date's own, before any is tried a size larger. A theme
   * whose words are too long for a small board so passes the day to the next.
   * `avoid` names a theme to pass over (yesterday's, when planning days ahead);
   * it is still used when no other theme can make the board.
   */
  function pickForDate(date, list = playable(), { avoid = null } = {}) {
    const parsed = parseDay(date);
    if (!parsed || !list.length) return null;
    const scheduled = sizeForDay(parsed.day);
    const passes = avoid && list.some((t) => t.title !== avoid) ? [avoid, null] : [null];
    // A full board first: a theme deep enough to hide what the size asks for.
    // Only when no such theme has a board does a thinner one take the day.
    const deep = list.filter((theme) => theme.words.length >= WORDS_BY_SIZE[scheduled][0]);
    for (const pool of deep.length ? [deep, list] : [list]) {
      for (const skip of passes) {
        for (let size = scheduled; size <= MAX_SIZE; size++) {
          for (let step = 0; step < pool.length; step++) {
            const theme = pool[(parsed.day + step) % pool.length];
            if (skip && theme.title === skip) continue;
            const seed = seedOf(parsed.day, size, step);
            const board = boardForTheme(theme, size, seed);
            if (board) return { theme: theme.title, size: board.size, seed, board };
          }
        }
      }
    }
    return null;
  }

  /**
   * The seasonal event's pick for a date — `{ theme, size, seed, board, event }`
   * — or null when the date has no event or its theme cannot make a board.
   * Same weekday size and seeds as pickForDate, growing the size when needed.
   */
  function eventPickForDate(date) {
    const parsed = parseDay(date);
    const event = parsed && eventFor(parsed.date);
    const theme = event && eventTheme(event.kind);
    if (!theme) return null;
    for (let size = sizeForDay(parsed.day); size <= MAX_SIZE; size++) {
      const seed = seedOf(parsed.day, size, 0);
      const board = boardForTheme(theme, size, seed);
      if (board) return { theme: theme.title, size: board.size, seed, board, event };
    }
    return null;
  }

  /**
   * What an unplanned date gets, and what the planners store: the event's pick,
   * else the rotation's (pickForDate, with its `avoid`). An event pick carries `event`.
   */
  const automaticPick = (date, list, options = {}) => eventPickForDate(date) ?? pickForDate(date, list, options);

  /**
   * The automatic board for a date — `{ date, theme, size, coins, rows, words }`
   * as the API sends it — or null for a bad date or when no theme can make one.
   */
  function forDate(date, list) {
    const pick = automaticPick(date, list);
    if (!pick) return null;
    return {
      date: parseDay(date).date,
      theme: pick.theme,
      size: pick.size,
      coins: appConfig.get().dailyPuzzleCoins,
      rows: pick.board.rows,
      words: pick.board.words,
    };
  }

  /**
   * A short board for Friday's marathon: the same themes, at the size the run
   * asks for, seeded away from the day's own board so the two never match.
   * Null when no theme fits a board that small.
   */
  function marathonBoard(date, size) {
    const parsed = parseDay(date);
    const list = playable();
    if (!parsed || !list.length) return null;
    for (let step = 0; step < list.length; step++) {
      const theme = list[(parsed.day + step + 1) % list.length];
      const board = boardForTheme(theme, size, seedOf(parsed.day, size, step) ^ 0x4d41524e);
      if (board) {
        return { date: parsed.date, theme: theme.title, size: board.size, rows: board.rows, words: board.words };
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

  /**
   * The panel's chooser: exactly these titles are used for new days, and every
   * other title that could make a board is excluded — one save instead of a
   * toggle each. A title too thin for a board is not a choice, so it is
   * ignored, and an empty choice is refused: the daily word search would have
   * nothing to build from.
   *
   * Returns `{ used, excluded }`, or `{ error }`.
   */
  function setPlayableTitles(chosen) {
    const wanted = new Set([chosen ?? []].flat().map((t) => String(t).trim()).filter(Boolean));
    const eligible = themes().filter((t) => t.eligible);
    const keep = eligible.filter((t) => wanted.has(t.title));
    if (!keep.length) return { error: 'اختر فئة واحدة على الأقل؛ بدونها لا يجد البحث اليومي ما يبني منه شبكة.' };
    const drop = eligible.filter((t) => !wanted.has(t.title));
    const exclude = db.prepare('INSERT INTO wordsearch_excluded_titles (title) VALUES (?) ON CONFLICT(title) DO NOTHING');
    const include = db.prepare('DELETE FROM wordsearch_excluded_titles WHERE title = ?');
    db.transaction(() => {
      for (const theme of drop) exclude.run(theme.title);
      for (const theme of keep) include.run(theme.title);
    })();
    return { used: keep.length, excluded: drop.length };
  }

  return {
    themes, playable, pickForDate, eventPickForDate, automaticPick, forDate, marathonBoard,
    setExcluded, setPlayableTitles,
  };
}
