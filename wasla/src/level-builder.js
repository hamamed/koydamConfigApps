/**
 * Builds levels automatically: ten questions each, from categories drawn at
 * random, with معلومات عامة always taking two of the ten so every level has a
 * couple of plain general-knowledge words in it.
 *
 * Whether a set of words crosses is only known by laying it out, so the answers
 * are picked against a grid being filled — each one chosen because it crosses
 * what is already down — and the finished set is laid out once more to confirm
 * the level really is one crossword.
 */

import { letters } from './arabic.js';
import { createBoard, generateLayout } from './layout.js';

/** How many different picks are tried for one level before giving up on it. */
export const TRIES_PER_LEVEL = 40;
/** A level needs at least this many words: fewer than two cannot cross. */
export const MIN_CATEGORIES = 2;
/** Questions in a generated level. */
export const LEVEL_SIZE = 10;
/** The category every level draws from twice, and how many of the ten it takes. */
export const MAIN_CATEGORY = 'معلومات عامة';
export const MAIN_SLOTS = 2;
/** Answers weighed against the grid for one slot: enough to find a crossing one. */
const CANDIDATES = 20;
/** The word the grid is built around reads best at about this many letters. */
const SPINE_LETTERS = 6;
/**
 * The longest answer a generated level takes. A ten-word grid holding a
 * fifteen-letter answer is fifteen columns wide before anything crosses it, and a
 * phone then draws every tile too small to read. Longer answers stay in the bank
 * for levels built by hand.
 */
export const MAX_LETTERS = 9;

/** Mulberry32, as the preview uses: the same plan for the same seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(list, random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A few entries at random, so two tries at the same slot weigh different answers. */
function sample(list, n, random) {
  if (list.length <= n) return [...list];
  const out = [];
  const seen = new Set();
  while (out.length < n) {
    const i = Math.floor(random() * list.length);
    if (seen.has(i)) continue;
    seen.add(i);
    out.push(list[i]);
  }
  return out;
}

const answerLength = (question) => letters(question.playAnswer).length;

/** Whether these questions cross as one crossword. */
export function wordsCross(questions) {
  return gradeSet(questions) !== null;
}

/**
 * How good a level these questions make, or null when their words do not all cross.
 *
 * A player reads a crossed letter off the word they already solved, so the more
 * crossings — and the tighter the grid holding them — the more one answer helps
 * with the next. Both are counted here, crossings first.
 */
export function gradeSet(questions) {
  if (questions.length < MIN_CATEGORIES) return null;
  const layout = generateLayout(questions.map((q) => ({ id: q.id, answer: q.playAnswer })));
  if (layout.unplaced.length) return null;
  const area = layout.rows * layout.cols;
  return { crossings: layout.crossings, area, score: layout.crossings * 10 - area / 8 };
}

/**
 * Plans up to `count` levels of `size` questions each.
 *
 * `questions` are the ones free to use (in no level yet), already filtered by
 * difficulty. `categories` narrows which categories may be drawn from; left
 * empty, every category in `questions` is fair game. Answers longer than
 * `maxLetters` are left out, so ten words still fit a phone's screen. `usedAnswers` are the words
 * the levels already hold: two questions can share a word (جميل is both a
 * synonym and an opposite), and a word the player has already solved — or one
 * twice in the same level — is not worth a second slot.
 *
 * Returns `{ levels, ranOutOf, ranOut, noCrossing }`: `ranOutOf` names a category
 * that must be in every level and has nothing left, `ranOut` says the bank no
 * longer holds a level's worth, and `noCrossing` says the questions left were
 * tried and do not cross — any of the three means fewer levels than asked for.
 */
export function planLevels({
  questions, categories = [], count = 1, seed = 1, size = LEVEL_SIZE,
  mainCategory = MAIN_CATEGORY, mainSlots = MAIN_SLOTS, maxLetters = MAX_LETTERS, usedAnswers = [],
}) {
  const wanted = [...new Set(categories.map((name) => String(name ?? '').trim()).filter(Boolean))];
  const short = questions.filter((q) => !maxLetters || answerLength(q) <= maxLetters);
  const present = [...new Set(short.map((q) => q.title).filter(Boolean))];
  const pool = wanted.length ? present.filter((name) => wanted.includes(name)) : present;
  const empty = { levels: [], ranOutOf: null, ranOut: false, noCrossing: false };

  if (size < MIN_CATEGORIES) {
    return { ...empty, error: `A level holds at least ${MIN_CATEGORIES} questions: its words have to cross.` };
  }
  if (pool.length < MIN_CATEGORIES) {
    return { ...empty, error: `Only ${pool.length} category has free questions; a level needs at least ${MIN_CATEGORIES}.` };
  }

  const random = mulberry32(seed);
  const taken = new Set(usedAnswers);
  // One pool per category, shuffled once so every level draws different questions.
  const pools = new Map(pool.map((name) => [
    name,
    shuffled(short.filter((q) => q.title === name && !taken.has(q.playAnswer)), random),
  ]));
  // A category every level must hold is no use once it is empty.
  const main = pools.get(mainCategory)?.length >= mainSlots ? mainCategory : null;

  const levels = [];
  let ranOutOf = null;
  let ranOut = false;
  let noCrossing = false;
  for (let made = 0; made < count; made++) {
    if (mainSlots > 0 && main && pools.get(main).length < mainSlots) { ranOutOf = main; break; }
    const free = [...pools.values()].reduce((sum, list) => sum + list.length, 0);
    if (free < size) { ranOut = true; break; }

    const picked = pickCrossingSet({ pools, size, main, mainSlots, random });
    if (!picked) { noCrossing = true; break; }

    picked.forEach((question) => taken.add(question.playAnswer));
    // The question is spent, and so is its word whichever category it came from:
    // no level repeats either.
    const ids = new Set(picked.map((q) => q.id));
    pools.forEach((list, name) => pools.set(name, list.filter((q) => !ids.has(q.id) && !taken.has(q.playAnswer))));
    levels.push(picked);
  }
  return { levels, ranOutOf, ranOut, noCrossing };
}

/**
 * One level's questions, or null when none of the tries crossed.
 *
 * Each try draws its own categories and its own answers, so a word that crosses
 * nothing is left behind rather than blocking the whole plan.
 */
function pickCrossingSet({ pools, size, main, mainSlots, random }) {
  for (let attempt = 0; attempt < TRIES_PER_LEVEL; attempt++) {
    const slots = slotPlan({ pools, size, main, mainSlots, random });
    if (!slots) return null;
    const picked = fillSlots({ slots, pools, random });
    // The grid the app draws is laid out from scratch, so it has the last word
    // on whether these ten really are one crossword.
    if (picked && gradeSet(picked)) return picked;
  }
  return null;
}

/**
 * Which category each of the level's slots draws from.
 *
 * The category that must be in every level takes its slots first; the rest go to
 * different categories drawn at random, so no two levels are the same mix. A bank
 * with fewer categories than slots gives some of them a second word.
 */
function slotPlan({ pools, size, main, mainSlots, random }) {
  const stocked = [...pools.keys()].filter((name) => pools.get(name).length);
  if (stocked.length < MIN_CATEGORIES) return null;

  const slots = [];
  if (main && mainSlots > 0) {
    for (let i = 0; i < Math.min(mainSlots, size); i++) slots.push(main);
  }
  const others = shuffled(stocked.filter((name) => name !== main), random);
  while (slots.length < size && others.length) slots.push(others.shift());
  const spare = shuffled(stocked, random);
  for (let i = 0; slots.length < size; i++) slots.push(spare[i % spare.length]);
  return shuffled(slots, random);
}

/**
 * Fills each slot with an answer that crosses what is already on the grid.
 *
 * The first word is the spine every other word hangs off, so a middling length is
 * taken for it; after that each slot's answer is the one that crosses the grid
 * best, which is what makes a level the player can work out rather than ten
 * separate words in disguise.
 */
function fillSlots({ slots, pools, random }) {
  const board = createBoard();
  const picked = [];
  const words = new Set();

  for (const name of slots) {
    const free = (pools.get(name) ?? []).filter((q) => !words.has(q.playAnswer) && !picked.includes(q));
    if (!free.length) return null;
    const tries = sample(free, CANDIDATES, random);

    if (!picked.length) {
      const spine = tries.reduce((best, q) => (
        Math.abs(answerLength(q) - SPINE_LETTERS) < Math.abs(answerLength(best) - SPINE_LETTERS) ? q : best));
      board.start({ id: spine.id, answer: spine.playAnswer });
      picked.push(spine);
      words.add(spine.playAnswer);
      continue;
    }

    let best = null;
    for (const question of tries) {
      const word = { id: question.id, answer: question.playAnswer };
      const spot = board.bestSpot(word);
      if (!spot) continue;
      if (!best || spot.score > best.spot.score) best = { question, word, spot };
    }
    if (!best) return null;
    board.place(best.word, best.spot);
    picked.push(best.question);
    words.add(best.question.playAnswer);
  }
  return picked;
}
