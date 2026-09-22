/**
 * سُلّم اليوم: the day as five rungs climbed in order (contract §9).
 *
 * A day used to be one game. A ladder is the five of them on one path — the
 * player starts at the bottom, and each rung opens the next — so a day is a
 * short run rather than a single puzzle, and the whole run can be raced: the
 * board «today-ladder» ranks the day by the stars the climb earned, and by the
 * time it took when the stars are level.
 *
 * The order rotates with the date, so no two days start the same way, and the
 * day's own game — the one the week names — is kept for the top rung.
 */

import { parseDay } from './daily.js';
import { kindForDay } from './daily-schedule.js';

/** How many rungs a day has, and how many stars a perfect climb is worth. */
export const LADDER_RUNGS = 5;
export const LADDER_STARS = LADDER_RUNGS * 3;

/**
 * The kinds a rung may be: the four daily games (GAME_KINDS in daily-games.js,
 * named here rather than imported — that module builds the ladder) and the
 * word search.
 */
export const LADDER_KINDS = Object.freeze(['bubbles', 'wheel', 'guess', 'connect', 'wordsearch']);

/**
 * The rungs of a date, bottom first. The day's own game is last; the rest
 * follow the date, so the same date always climbs the same way.
 */
export function rungsFor(day) {
  const own = kindForDay(day);
  const rest = LADDER_KINDS.filter((kind) => kind !== own);
  const turn = ((day % rest.length) + rest.length) % rest.length;
  const order = [...rest.slice(turn), ...rest.slice(0, turn)];
  // Friday names the marathon, which is not a rung; the ladder keeps its five
  // games and the marathon stays where it is, as the day's extra.
  return LADDER_KINDS.includes(own) ? [...order, own] : order.slice(0, LADDER_RUNGS);
}

/**
 * `{ date, rungs: [{ step, kind, coins }], stars, bonus }` — what the app
 * climbs and what it pays. A rung whose game the day cannot build is dropped,
 * so a thin day is a shorter ladder rather than a broken one.
 */
export function ladderFor(date, { games = {}, coins = 0, bonus = 0 } = {}) {
  const parsed = parseDay(date);
  if (!parsed) return null;

  const rungs = rungsFor(parsed.day)
    .filter((kind) => games[kind])
    .map((kind, index) => ({ step: index + 1, kind, coins }));
  if (!rungs.length) return null;

  return { date: parsed.date, rungs, stars: rungs.length * 3, bonus };
}
