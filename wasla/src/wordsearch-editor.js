/**
 * Composing one day's word search in the panel: the words the admin picked or
 * typed, a size and a seed become a board — or a list of reasons it cannot be
 * saved yet. Pure apart from `newSeed`, so the preview the admin sees and the
 * board that is saved come from the same inputs and are the same board.
 */

import crypto from 'node:crypto';

import { answerProblem, foldForPlay, letters, normalizeAnswer } from './arabic.js';
import { MAX_TITLE } from './repository.js';
import {
  MAX_BOARD_WORDS, MAX_WORD_LETTERS, MIN_THEME_WORDS, MIN_WORD_LETTERS, WORDS_BY_SIZE,
} from './wordsearch-daily.js';
import { buildBoard, cellsOf, MAX_SIZE, MIN_SIZE } from './wordsearch.js';

/**
 * Words typed in the panel belong to no question, but the app needs a unique
 * whole-number id per word (it keys found words by it and sends it back in
 * `wordsearch_word_found`). They take ids from here up — far above any
 * question id, so a custom word is never counted as a question.
 */
export const CUSTOM_WORD_ID_BASE = 1_000_000_000;

export const ARABIC_WEEKDAYS = Object.freeze(['الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت', 'الأحد']);

/** Soft, distinct line colours for the found-word strokes in the preview. */
const LINE_COLOURS = ['#ff7a59', '#14a49e', '#6b63c9', '#f5b82e', '#2e9b74', '#e5679b', '#3b8fe0', '#a066d3', '#f08a3c', '#5bb8b0'];

/** Where each direction points on screen, column 0 being the right edge. */
const ARROWS = { '0,1': '←', '0,-1': '→', '1,0': '↓', '-1,0': '↑', '1,1': '↙', '1,-1': '↘', '-1,1': '↖', '-1,-1': '↗' };

/** A fresh seed for Shuffle: a positive 31-bit whole number. */
export const newSeed = () => crypto.randomInt(1, 2 ** 31);

/** A seed from a form, or null when it is not a usable one. */
export function readSeed(raw) {
  const seed = Number(raw);
  return Number.isInteger(seed) && seed >= 1 && seed < 2 ** 32 ? seed : null;
}

/** A size from a form, or null. */
export function readSize(raw) {
  const size = Number(raw);
  return Number.isInteger(size) && size >= MIN_SIZE && size <= MAX_SIZE ? size : null;
}

/** How many of a theme's words to tick by default for a board size. */
export const defaultWordCount = (size) => (WORDS_BY_SIZE[size] ?? [MIN_THEME_WORDS, MAX_BOARD_WORDS])[1];

const reversed = (word) => [...word].reverse().join('');

/**
 * Words typed one per line: `{ words, errors }`. Each word is checked with the
 * question form's answer rules and folded for play like an answer: 3–8
 * letters, each once, none readable inside another (forwards or backwards),
 * since it would be found twice. How many there are is composeDay's check.
 */
export function readCustomWords(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const errors = [];
  const words = [];
  for (const line of lines) {
    const display = normalizeAnswer(line);
    const problem = answerProblem(display);
    if (problem) {
      errors.push(`“${line}”: ${problem}`);
      continue;
    }
    const word = foldForPlay(display);
    const count = letters(word).length;
    if (count < MIN_WORD_LETTERS || count > MAX_WORD_LETTERS) {
      errors.push(`“${display}” has ${count} letters; a word search word has ${MIN_WORD_LETTERS}–${MAX_WORD_LETTERS}.`);
    } else if (words.some((w) => w.word === word)) {
      errors.push(`“${display}” is in the list twice${display === word ? '' : ` (played as ${word})`}.`);
    } else {
      words.push({ id: null, word, display });
    }
  }
  const hidden = new Set();
  for (const inner of words) {
    const outer = words.find((w) => w !== inner && (w.word.includes(inner.word) || w.word.includes(reversed(inner.word)))
      && (letters(w.word).length > letters(inner.word).length || words.indexOf(w) < words.indexOf(inner)));
    if (!outer) continue;
    hidden.add(inner);
    errors.push(`“${inner.display}” can be read inside “${outer.display}”, so it would be found twice. Remove one.`);
  }
  const clean = words.filter((w) => !hidden.has(w));
  return { words: clean, errors };
}

function countProblem(count) {
  if (count < MIN_THEME_WORDS) return [`Choose at least ${MIN_THEME_WORDS} words (${count} now).`];
  if (count > MAX_BOARD_WORDS) return [`Choose at most ${MAX_BOARD_WORDS} words (${count} now).`];
  return [];
}

/** The theme name shown above the board: 1–40 characters. */
export function readThemeName(raw) {
  const theme = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!theme) return { error: 'Give the puzzle a theme name.' };
  if ([...theme].length > MAX_TITLE) return { error: `A theme name can be at most ${MAX_TITLE} characters.` };
  return { theme };
}

/** Why a word was left off, in words the admin can act on. */
function droppedMessage(reason, size) {
  if (reason === 'too-long') return `longer than a ${size} × ${size} board — choose a bigger size`;
  if (reason === 'contained') return 'can be read inside another word — remove one of them';
  return size < MAX_SIZE
    ? `no room left on a ${size} × ${size} board — try Shuffle, fewer words or size ${size + 1}`
    : 'no room left on the board — try Shuffle or fewer words';
}

/**
 * A board for `words` ({ id|null, word, display }) at `size` with `seed`:
 * `{ board, dropped, problems, canSave }`.
 *
 * `board` is what is stored and served, minus date and coins: `{ theme, size,
 * rows, words }`. Words without an id get CUSTOM_WORD_ID_BASE + their place.
 * It can only be saved when every word is on it and nothing else is wrong.
 */
export function composeDay({ theme, words, size, seed, problems = [] }) {
  const all = [...problems];
  const list = Array.isArray(words) ? words : [];
  if (!readSize(size)) all.push(`A board is ${MIN_SIZE} to ${MAX_SIZE} letters square.`);
  if (!readSeed(seed)) all.push('The board needs a seed; press Shuffle.');
  all.push(...countProblem(list.length));
  if (!readSize(size) || !readSeed(seed) || !list.length) return { board: null, dropped: [], problems: all, canSave: false };

  const withIds = list.map((w, i) => ({ id: w.id ?? CUSTOM_WORD_ID_BASE + i + 1, word: w.word, display: w.display }));
  const built = buildBoard({ words: withIds, size, seed });
  const byId = new Map(withIds.map((w) => [w.id, w]));
  const dropped = built.dropped.map((d) => ({
    ...d,
    display: byId.get(d.id)?.display ?? d.word,
    message: droppedMessage(d.reason, size),
  }));
  const board = { theme, size, rows: built.rows, words: built.words };
  return { board, dropped, problems: all, canSave: !all.length && !dropped.length && Boolean(theme) };
}

/** The board as the preview draws it: letters per cell, and a line per word in screen coordinates. */
export function previewOf(board) {
  const { size } = board;
  const x = (col) => size - col - 0.5; // column 0 on the right
  const y = (row) => row + 0.5;
  return {
    ...board,
    cells: board.rows.map((row) => [...row]),
    words: board.words.map((w, i) => {
      const cells = cellsOf(w);
      const [first, last] = [cells[0], cells.at(-1)];
      return {
        ...w,
        colour: LINE_COLOURS[i % LINE_COLOURS.length],
        arrow: ARROWS[`${w.dRow},${w.dCol}`],
        length: cells.length,
        line: { x1: x(first[1]), y1: y(first[0]), x2: x(last[1]), y2: y(last[0]) },
      };
    }),
  };
}
