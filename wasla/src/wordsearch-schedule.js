/**
 * The planned daily word search: boards stored per date in `wordsearch_days`.
 *
 * A stored board is frozen when it is saved — editing or deleting questions
 * afterwards changes nothing about it — and it is served exactly as saved,
 * with `coins` from the current config. A date without a stored board falls
 * back to the automatic board (src/wordsearch-daily.js), so an unplanned day
 * still has a puzzle.
 */

import { dayToDate, parseDay } from './daily.js';
import { MAX_BOARD_WORDS, MIN_THEME_WORDS } from './wordsearch-daily.js';
import { MAX_SIZE, MIN_SIZE } from './wordsearch.js';

export const SOURCES = Object.freeze(['theme', 'custom']);
/** The most days one "Add days" press can plan. */
export const MAX_ADD_DAYS = 60;
/** Fewer planned days ahead than this and the panel warns. */
export const LOW_DAYS_AHEAD = 7;

const parseJson = (text, date) => {
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error(`wordsearch_days ${date}: unreadable JSON, serving the automatic board`, err);
    return null;
  }
};

function dayOf(row) {
  if (!row) return null;
  const board = parseJson(row.board, row.date);
  const words = parseJson(row.words, row.date);
  if (!board || !words) return null;
  return {
    date: row.date,
    theme: row.theme,
    size: row.size,
    words,
    seed: row.seed,
    board,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Why a board cannot be stored, or null. Checks the shape the app relies on. */
export function boardProblem(board) {
  if (!board || typeof board !== 'object') return 'There is no board to save.';
  const { size, rows, words, theme } = board;
  if (!theme || typeof theme !== 'string') return 'The board has no theme.';
  if (!Number.isInteger(size) || size < MIN_SIZE || size > MAX_SIZE) return `A board is ${MIN_SIZE} to ${MAX_SIZE} letters square.`;
  if (!Array.isArray(rows) || rows.length !== size || rows.some((r) => [...r].length !== size)) return 'The board rows do not match its size.';
  if (!Array.isArray(words) || words.length < MIN_THEME_WORDS || words.length > MAX_BOARD_WORDS) {
    return `A board has ${MIN_THEME_WORDS} to ${MAX_BOARD_WORDS} words.`;
  }
  const ids = new Set(words.map((w) => w.id));
  if (ids.size !== words.length || words.some((w) => !Number.isInteger(w.id) || w.id < 1)) return 'Every word needs its own id.';
  const grid = rows.map((r) => [...r]);
  const spelled = (w) => [...w.word].every((letter, i) => grid[w.row + i * w.dRow]?.[w.col + i * w.dCol] === letter);
  if (!words.every(spelled)) return 'A word does not match the board letters.';
  return null;
}

/** How a planner stores a pick: an event's theme is not a title's, so it is saved as typed words. */
export const sourceOf = (pick) => (pick.event ? 'custom' : 'theme');

export function createWordSearchSchedule(db, { wordSearch, appConfig }) {
  const selectOne = db.prepare('SELECT * FROM wordsearch_days WHERE date = ?');

  const get = (date) => dayOf(selectOne.get(String(date)));

  /** The board the API serves for a date: the stored one, else the automatic one, else null. */
  function boardFor(date) {
    const parsed = parseDay(date);
    if (!parsed) return null;
    const day = get(parsed.date);
    if (!day) return wordSearch.forDate(parsed.date);
    const { theme, size, rows, words } = day.board;
    return { date: parsed.date, theme, size, coins: appConfig.get().dailyPuzzleCoins, rows, words };
  }

  /** Stores (or replaces) a date's board. `{}` or `{ error }`. */
  function save(date, { theme, size, words, seed, board, source }) {
    const parsed = parseDay(date);
    if (!parsed) return { error: 'That is not a valid date.' };
    if (!SOURCES.includes(source)) return { error: 'Unknown theme source.' };
    const problem = boardProblem(board);
    if (problem) return { error: problem };
    if (board.theme !== theme || board.size !== size) return { error: 'The board does not match its theme and size.' };
    const frozen = {
      theme: board.theme,
      size: board.size,
      rows: [...board.rows],
      words: board.words.map(({ id, word, display, row, col, dRow, dCol }) => ({ id, word, display, row, col, dRow, dCol })),
    };
    const list = (words ?? []).map(({ id, word, display }) => ({ id: id ?? null, word, display }));
    db.prepare(`INSERT INTO wordsearch_days (date, theme, size, words, seed, board, source)
      VALUES (@date, @theme, @size, @words, @seed, @board, @source)
      ON CONFLICT(date) DO UPDATE SET theme = excluded.theme, size = excluded.size, words = excluded.words,
        seed = excluded.seed, board = excluded.board, source = excluded.source, updated_at = datetime('now')`).run({
      date: parsed.date, theme, size, words: JSON.stringify(list), seed, board: JSON.stringify(frozen), source,
    });
    return {};
  }

  /** Deletes a date's board; the date falls back to automatic. True when there was one. */
  const remove = (date) => db.prepare('DELETE FROM wordsearch_days WHERE date = ?').run(String(date)).changes > 0;

  const list = (sql, ...args) => db.prepare(sql).all(...args).map(dayOf).filter(Boolean);

  /** Stored days from `date` on, in date order. */
  const fromDate = (date) => list('SELECT * FROM wordsearch_days WHERE date >= ? ORDER BY date', date);

  /** Stored days before `date`, newest first. */
  const beforeDate = (date, limit = 60) => list('SELECT * FROM wordsearch_days WHERE date < ? ORDER BY date DESC LIMIT ?', date, limit);

  const lastDate = () => db.prepare('SELECT MAX(date) FROM wordsearch_days').pluck().get() ?? null;

  /**
   * What the schedule page's header says: `{ lastDate, daysAhead, low,
   * todayScheduled, gaps }` — `daysAhead` counts days after today up to the
   * last planned one, `gaps` the unplanned dates in between.
   */
  function summary(today) {
    const start = parseDay(today);
    const last = lastDate();
    const lastDay = last ? parseDay(last).day : null;
    const daysAhead = lastDay !== null && lastDay >= start.day ? lastDay - start.day : 0;
    const planned = lastDay !== null && lastDay >= start.day
      ? db.prepare('SELECT COUNT(*) FROM wordsearch_days WHERE date >= ? AND date <= ?').pluck().get(today, last)
      : 0;
    return {
      lastDate: lastDay !== null && lastDay >= start.day ? last : null,
      daysAhead,
      low: daysAhead < LOW_DAYS_AHEAD,
      todayScheduled: Boolean(selectOne.get(today)),
      gaps: lastDay !== null && lastDay >= start.day ? daysAhead + 1 - planned : 0,
    };
  }

  /**
   * Plans `count` more days: from the day after the last planned date, or
   * from today when nothing is planned from today on. Each date takes the
   * automatic rotation's theme and weekday size, passing over the previous
   * day's theme when another fits, and its board is stored as generated. A
   * seasonal event date takes its event's built-in theme instead, stored as
   * `custom` (its words belong to no question) so the day's editor can open it.
   * `{ added: [{ date, theme, size }], skipped: [date], from, to }` — a date is
   * skipped only when no theme can make a board for it.
   */
  function addDays(count, today) {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > MAX_ADD_DAYS) return { error: `Add 1 to ${MAX_ADD_DAYS} days at a time.` };
    const start = parseDay(today);
    if (!start) return { error: 'That is not a valid date.' };
    const last = lastDate();
    const firstDay = last && parseDay(last).day >= start.day ? parseDay(last).day + 1 : start.day;

    const themes = wordSearch.playable();
    const themeOn = (date) => get(date)?.theme ?? wordSearch.automaticPick(date, themes)?.theme ?? null;
    const added = [];
    const skipped = [];
    db.transaction(() => {
      let previous = themeOn(dayToDate(firstDay - 1));
      for (let i = 0; i < n; i++) {
        const date = dayToDate(firstDay + i);
        const pick = wordSearch.automaticPick(date, themes, { avoid: previous });
        if (!pick) {
          skipped.push(date);
          previous = null;
          continue;
        }
        const words = pick.board.words;
        const board = { theme: pick.theme, size: pick.size, rows: pick.board.rows, words };
        const result = save(date, { theme: pick.theme, size: pick.size, words, seed: pick.seed, board, source: sourceOf(pick) });
        if (result.error) {
          skipped.push(date);
          previous = null;
          continue;
        }
        added.push({ date, theme: pick.theme, size: pick.size });
        previous = pick.theme;
      }
    })();
    return { added, skipped, from: dayToDate(firstDay), to: dayToDate(firstDay + n - 1) };
  }

  return { get, boardFor, save, remove, fromDate, beforeDate, lastDate, summary, addDays };
}
