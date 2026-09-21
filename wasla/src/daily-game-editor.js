/**
 * The panel's day editor for the five daily games (contract §6): each game as
 * plain text a person can edit, and back.
 *
 * The text is prefilled from whatever the date would serve (a saved game or the
 * automatic pick), so planning a day is mostly reading and fixing a line or two.
 *
 *   scramble  one word per line: `answer | clue`
 *   bubbles   first line the theme, then one word per line
 *   groups    one group per line: `title: word، word، word، word`
 *   wheel     one line: `letters: word word word`
 *   guess     one word
 *
 * Every parser answers `{ game }` in the exact shape the API sends, or
 * `{ errors: [...] }` with every problem found, never both.
 */

import { foldForPlay, letters, normalizeAnswer } from './arabic.js';
import {
  BUBBLE_LETTERS, GUESS_LETTERS, GUESS_TRIES, GUESS_WORDS, parseWheelSets, scrambleLetters, splitParts,
} from './daily-games.js';
import { random, shuffled } from './wordsearch.js';

/** Ids for words typed in the panel: they belong to no question, and stay clear of question ids. */
export const TYPED_ID_BASE = 2_000_000_000;
export const SCRAMBLE_RANGE = Object.freeze([3, 8]);
export const BUBBLE_RANGE = Object.freeze([3, 8]);

const ARABIC_WORD = /^[ء-غف-ي]+$/u;
const lines = (text) => String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const inRange = (n, [min, max]) => n >= min && n <= max;
const newSeed = () => Math.floor(Math.random() * 2 ** 31);

/** A typed word: `{ word, display }`, or `{ error }`. */
function readWord(raw, [min, max], line) {
  const display = normalizeAnswer(raw);
  if (!display) return { error: `Line ${line}: a word is missing.` };
  if (!ARABIC_WORD.test(display)) return { error: `Line ${line}: “${raw}” must be Arabic letters only.` };
  const word = foldForPlay(display);
  const count = letters(word).length;
  if (!inRange(count, [min, max])) return { error: `Line ${line}: “${display}” has ${count} letters; use ${min}–${max}.` };
  return { word, display };
}

// ── Bubbles ──────────────────────────────────────────────────────────────────

export const bubblesText = (game) => (game ? [game.theme, ...game.words.map((w) => w.display)].join('\n') : '');

export function readBubbles(text, seed = newSeed()) {
  const [themeLine, ...wordLines] = lines(text);
  const errors = [];
  const theme = String(themeLine ?? '').trim();
  if (!theme) errors.push('Line 1 is the theme.');
  else if ([...theme].length > 40) errors.push('The theme can be at most 40 characters.');
  const words = [];
  const seen = new Set();
  wordLines.forEach((line, i) => {
    const read = readWord(line, [Math.max(BUBBLE_RANGE[0], 3), BUBBLE_LETTERS[1]], i + 2);
    if (read.error) return errors.push(read.error);
    if (seen.has(read.word)) return errors.push(`Line ${i + 2}: “${read.display}” is listed twice.`);
    seen.add(read.word);
    words.push({ id: TYPED_ID_BASE + i + 1, ...read, parts: splitParts(read.word) });
  });
  if (!errors.length && (words.length < 3 || words.length > 8)) errors.push('Give 3 to 8 words under the theme.');
  if (errors.length) return { errors };
  return { game: { theme, words, bubbles: shuffled(words.flatMap((w) => w.parts), random(seed)) } };
}

// ── Wheel ────────────────────────────────────────────────────────────────────

export const wheelText = (game) => (game ? `${game.letters}: ${game.words.join(' ')}` : '');

export function readWheel(text, seed = newSeed()) {
  const rows = lines(text);
  if (rows.length !== 1) return { errors: ['Write one line: letters: word word word.'] };
  const { sets, problems } = parseWheelSets(rows[0]);
  if (problems.length) return { errors: problems.map((p) => p.reason) };
  const set = sets[0];
  const words = [...set.words].sort((a, b) => letters(a).length - letters(b).length || (a < b ? -1 : 1));
  return { game: { letters: scrambleLetters(set.letters, random(seed)) ?? set.letters, words } };
}

// ── Guess ────────────────────────────────────────────────────────────────────

export const guessText = (game) => (game?.words ?? (game?.display ? [{ display: game.display }] : [])).map((w) => w.display).join('\n');

/** One word per line, up to the two the day hides at once. */
export function readGuess(text) {
  const rows = lines(text);
  if (!rows.length || rows.length > GUESS_WORDS) return { errors: [`اكتب كلمة أو ${GUESS_WORDS}، واحدة في كل سطر.`] };
  const words = [];
  for (const [i, row] of rows.entries()) {
    const read = readWord(row, [GUESS_LETTERS, GUESS_LETTERS], i + 1);
    if (read.error) return { errors: [read.error] };
    if (words.some((w) => w.word === read.word)) return { errors: [`«${read.display}» مكتوبة مرتين.`] };
    words.push({ word: read.word, display: read.display });
  }
  return { game: { words, word: words[0].word, display: words[0].display, tries: GUESS_TRIES } };
}

/** Each game's text form and parser, by kind. */
export const EDITORS = Object.freeze({
  bubbles: { toText: bubblesText, read: readBubbles },
  wheel: { toText: wheelText, read: readWheel },
  guess: { toText: guessText, read: readGuess },
});
