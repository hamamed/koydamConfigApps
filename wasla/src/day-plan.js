/**
 * Planning a day: saving the automatic pick of its word search and of every
 * game not planned yet, so later edits to questions or lists no longer move it.
 *
 * The panel's «خطّط» does it by hand; the app's API does it for a coming day the
 * first time a phone downloads it to play offline — so that everyone who plays
 * that day gets the very games that phone already has.
 */
import { addDays } from './players.js';
import { sourceOf } from './wordsearch-schedule.js';

/** How many coming days a phone may download ahead to play offline. */
export const AHEAD_DAYS = 7;

export function createDayPlanner({ dailyGames, wordSearch, wordSearchDays }) {
  /** Plans the word search and every game on `date` that is not planned yet. `{ wordSearch, games }` */
  function planDate(date, previousTheme) {
    let theme = wordSearchDays.get(date)?.theme ?? null;
    let wordSearchAdded = false;
    if (!theme) {
      const pick = wordSearch.automaticPick(date, wordSearch.playable(), { avoid: previousTheme });
      if (pick) {
        const board = { theme: pick.theme, size: pick.size, rows: pick.board.rows, words: pick.board.words };
        const saved = wordSearchDays.save(date, { theme: pick.theme, size: pick.size, words: pick.board.words, seed: pick.seed, board, source: sourceOf(pick) });
        if (!saved.error) {
          theme = pick.theme;
          wordSearchAdded = true;
        }
      }
    }
    return { theme, wordSearchAdded, gamesAdded: dailyGames.freeze(date).added };
  }

  /**
   * Plans `date` when it is one of the coming AHEAD_DAYS (after `today`), and
   * only once: a day planned already is left as it is.
   */
  function planAhead(date, today) {
    if (!wordSearch || !wordSearchDays || !dailyGames) return false;
    if (date <= today || date > addDays(today, AHEAD_DAYS)) return false;
    const previousTheme = wordSearchDays.get(addDays(date, -1))?.theme ?? null;
    planDate(date, previousTheme);
    return true;
  }

  return { planDate, planAhead };
}
