/**
 * Builds levels automatically: one question from each chosen category, so every
 * level mixes the categories the same way, and the words cross.
 *
 * Whether a set of words crosses is only known by laying it out, so the planner
 * takes a `fits` function (the layout) and tries other picks when a set fails.
 */

import { generateLayout } from './layout.js';

/** How many different picks are tried for one level before giving up on it. */
export const TRIES_PER_LEVEL = 40;
/** A level needs at least this many categories: fewer words than this cannot cross. */
export const MIN_CATEGORIES = 2;

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

/** Whether these questions cross as one crossword. */
export function wordsCross(questions) {
  if (questions.length < MIN_CATEGORIES) return false;
  const layout = generateLayout(questions.map((q) => ({ id: q.id, answer: q.playAnswer })));
  return layout.unplaced.length === 0;
}

/**
 * Plans up to `count` levels, each with one question per category.
 *
 * `questions` are the ones free to use (in no level yet), already filtered by
 * difficulty. Returns `{ levels: [[question, …], …], ranOutOf, noCrossing }`:
 * `ranOutOf` names the category that has no question left, and `noCrossing` says
 * the remaining questions were tried and do not cross — either one means fewer
 * levels than asked for.
 */
export function planLevels({ questions, categories, count = 1, seed = 1, fits = wordsCross }) {
  const wanted = categories.filter((name, at) => name && categories.indexOf(name) === at);
  if (wanted.length < MIN_CATEGORIES) {
    return {
      levels: [], ranOutOf: null, noCrossing: false,
      error: `Choose at least ${MIN_CATEGORIES} categories: a level's words have to cross.`,
    };
  }

  const random = mulberry32(seed);
  // One pool per category, shuffled once so every level draws different questions.
  const pools = new Map(wanted.map((name) => [
    name,
    shuffled(questions.filter((q) => q.title === name), random),
  ]));

  const levels = [];
  let ranOutOf = null;
  let noCrossing = false;
  for (let made = 0; made < count; made++) {
    const empty = wanted.find((name) => pools.get(name).length === 0);
    if (empty) { ranOutOf = empty; break; }

    const picked = pickCrossingSet({ wanted, pools, fits, random });
    if (!picked) { noCrossing = true; break; }

    picked.forEach((question) => {
      const pool = pools.get(question.title);
      pool.splice(pool.indexOf(question), 1);
    });
    levels.push(picked);
  }
  return { levels, ranOutOf, noCrossing };
}

/**
 * One question per category whose words cross, or null when none of the tries did.
 * Each try takes a different question from the categories, so a word that crosses
 * nothing is left behind rather than blocking the whole plan.
 */
function pickCrossingSet({ wanted, pools, fits, random }) {
  for (let attempt = 0; attempt < TRIES_PER_LEVEL; attempt++) {
    const picked = wanted.map((name) => {
      const pool = pools.get(name);
      // The first try takes the front of each pool; later ones look further down it.
      const at = attempt === 0 ? 0 : Math.floor(random() * pool.length);
      return pool[at];
    });
    if (picked.some((q) => !q)) return null;
    if (new Set(picked.map((q) => q.id)).size !== picked.length) continue;
    if (fits(picked)) return picked;
  }
  return null;
}
