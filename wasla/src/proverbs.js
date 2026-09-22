/**
 * اكشف المثل: a proverb with one word missing, spelled from a board of letters.
 *
 * The content is the قوافي list the panel already holds (src/lab.js): a proverb
 * with `ــــ` marking the gap, the word that fills it, and where it comes from.
 * A line may end with an emoji part, which becomes the clue over the board.
 *
 * The board is the proverb's own letters, each tile carrying the number of the
 * word it belongs to. The app colours the tiles by that number, so the missing
 * word's letters stand apart — which is the whole hint, and why the letters of
 * the other words are worth having on the board at all.
 */

import { foldForPlay, letters, normalizeAnswer } from './arabic.js';
import { parseDay } from './daily.js';
import { random, shuffled } from './wordsearch.js';

/** How many tiles the board holds: four rows of four, as the app draws it. */
export const PROVERB_TILES = 16;
/** A round needs the missing word's letters, and a few more to hide them among. */
export const PROVERB_MIN_EXTRA = 3;

const ARABIC_WORD = /^[ء-غف-ي]+$/u;
const words = (text) => String(text ?? '').split(/\s+/).map((word) => word.trim()).filter(Boolean);

/** A fixed shuffle, so neighbouring lines of the list are not neighbouring days. */
const rotation = (list, day, salt) => (list.length ? shuffled(list, random(salt))[((day % list.length) + list.length) % list.length] : null);

/**
 * The round as the app plays it, or null when the riddle cannot make one: the
 * word to spell must be Arabic letters, and there must be letters to hide it among.
 */
export function buildProverb(riddle, seed) {
  if (!riddle) return null;
  const display = normalizeAnswer(riddle.answer ?? '');
  const answer = foldForPlay(display);
  const answerLetters = letters(answer);
  if (!ARABIC_WORD.test(answer) || answerLetters.length < 2) return null;

  const rand = random(seed);
  const before = words(riddle.before);
  const after = words(riddle.after);
  const hiddenIndex = before.length;
  const all = [
    ...before.map((text) => ({ text, hidden: false })),
    { text: display, hidden: true },
    ...after.map((text) => ({ text, hidden: false })),
  ];

  // Every other word's letters, each remembering which word it came from.
  const spare = [];
  all.forEach((word, index) => {
    if (index === hiddenIndex) return;
    for (const letter of letters(foldForPlay(word.text))) {
      if (ARABIC_WORD.test(letter)) spare.push({ letter, group: index });
    }
  });
  if (spare.length < PROVERB_MIN_EXTRA) return null;

  const tiles = [
    ...answerLetters.map((letter) => ({ letter, group: hiddenIndex })),
    ...shuffled(spare, rand).slice(0, Math.max(PROVERB_MIN_EXTRA, PROVERB_TILES - answerLetters.length)),
  ];

  return {
    emoji: String(riddle.emoji ?? '').trim(),
    words: all.map((word, index) => ({
      text: word.text,
      hidden: word.hidden,
      ...word.hidden ? { letters: answerLetters.length } : {},
      group: index,
    })),
    hidden: hiddenIndex,
    answer,
    answerDisplay: display,
    letters: shuffled(tiles, rand),
    source: String(riddle.source ?? '').trim(),
  };
}

/** The round a date plays, from the قوافي list. `nonce` asks for another. */
export function proverbForDate(riddles, date, { nonce = 0 } = {}) {
  const parsed = parseDay(date);
  if (!parsed || !riddles?.length) return null;
  const step = Number.isFinite(Number(nonce)) ? Math.trunc(Number(nonce)) : 0;
  const riddle = rotation(riddles, parsed.day + step, 0x9a0b);
  const seed = (Math.imul(parsed.day + 1, 2246822519) ^ Math.imul(step + 11, 3266489917)) >>> 0;
  return buildProverb(riddle, seed);
}
