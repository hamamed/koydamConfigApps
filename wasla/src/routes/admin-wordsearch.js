import { parseDay, todayUtc } from '../daily.js';
import { addDays } from '../players.js';
import { CLOSE_THEME_WORDS, MIN_THEME_WORDS, sizeForDay, WEEKDAY_NAMES, weekdayOf } from '../wordsearch-daily.js';
import { cellsOf } from '../wordsearch.js';

export const UPCOMING_DAYS = 7;

/** Soft, distinct line colours for the found-word strokes in the preview. */
const LINE_COLOURS = ['#ff7a59', '#14a49e', '#6b63c9', '#f5b82e', '#2e9b74', '#e5679b', '#3b8fe0', '#a066d3', '#f08a3c', '#5bb8b0'];

/** Where each direction points on screen, column 0 being the right edge. */
const ARROWS = { '0,1': '←', '0,-1': '→', '1,0': '↓', '-1,0': '↑', '1,1': '↙', '1,-1': '↘', '-1,1': '↖', '-1,-1': '↗' };

/** The board as the preview draws it: letters per cell, and a line per word in screen coordinates. */
function previewOf(board) {
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

/** The word search page: themes, exclusions and a preview of any date's board. */
export function registerWordSearch(router, { wordSearch }) {
  router.get('/wordsearch', (req, res) => {
    const today = todayUtc();
    const parsed = parseDay(String(req.query.date ?? today));
    const date = parsed?.date ?? today;
    const day = parseDay(date).day;

    const themes = wordSearch.themes();
    const playable = themes.filter((t) => t.eligible && !t.excluded);
    const board = wordSearch.forDate(date, playable);
    const upcoming = Array.from({ length: UPCOMING_DAYS }, (_, i) => {
      const d = addDays(today, i);
      const pick = wordSearch.forDate(d, playable);
      return { date: d, weekday: WEEKDAY_NAMES[weekdayOf(parseDay(d).day)], theme: pick?.theme ?? null, size: pick?.size ?? null, words: pick?.words.length ?? 0 };
    });

    res.render('wordsearch', {
      title: 'Word search',
      today,
      date,
      badDate: req.query.date !== undefined && !parsed,
      weekday: WEEKDAY_NAMES[weekdayOf(day)],
      scheduledSize: sizeForDay(day),
      board: board && previewOf(board),
      eligible: themes.filter((t) => t.eligible),
      close: themes.filter((t) => !t.eligible && t.words.length >= CLOSE_THEME_WORDS),
      playableCount: playable.length,
      upcoming,
      minWords: MIN_THEME_WORDS,
    });
  });

  router.post('/wordsearch/exclude', (req, res) => {
    const excluded = req.body.excluded === '1';
    const result = wordSearch.setExcluded(req.body.title, excluded);
    const title = String(req.body.title ?? '').trim();
    req.flash(result.error ? 'danger' : 'success', result.error
      ?? (excluded ? `“${title}” is no longer used for the word search.` : `“${title}” is back in the word search.`));
    const date = parseDay(String(req.body.date ?? ''))?.date;
    res.redirect(`/admin/wordsearch${date ? `?date=${date}` : ''}`);
  });
}
