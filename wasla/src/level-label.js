/**
 * Levels have no names. The panel calls a level by its place in the full list
 * ("Level 3"); the app numbers published levels only, so a draft between them
 * can make the two differ — the panel shows the app number beside it then.
 */

/** "Level 3": a level as the panel names it, by its place among all levels. */
export const levelLabel = (number) => `Level ${number}`;

/** The `title` the API sends for compatibility; the app builds its own. */
export const appLevelTitle = (number) => `لغز رقم ${number}`;

/** The daily puzzle's `title` in the API. */
export const DAILY_TITLE = 'لغز اليوم';

/** "Level 3", plus " (app 2)" when the published number differs. */
export function levelName({ number, publishedNumber }) {
  const base = levelLabel(number);
  return publishedNumber && publishedNumber !== number ? `${base} (app ${publishedNumber})` : base;
}
