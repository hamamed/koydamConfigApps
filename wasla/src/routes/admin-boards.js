import { BOARDS } from '../profiles.js';
import { todayUtc } from '../daily.js';

/** What each board is, in the app's words and in the panel's. */
export const BOARD_LABELS = Object.freeze({
  'today-allgames': { en: "Today's games", ar: 'ألعاب اليوم', note: 'Fastest total for the word search and the five games today', unit: 'time' },
  'today-wordsearch': { en: "Today's word search", ar: 'كلمات اليوم', note: 'Fastest word search today', unit: 'time' },
  stars: { en: 'Main game', ar: 'اللعبة الرئيسية', note: 'Most stars from the levels', unit: 'stars' },
  points: { en: 'Points', ar: 'النقاط', note: 'Most points across everything', unit: 'points' },
  streak: { en: 'Streaks', ar: 'السلاسل', note: 'Longest run of days still alive', unit: 'days' },
});

const BOARD_SIZE = 50;

/** m:ss, as the app prints a daily time. */
export function clockText(seconds) {
  const s = Math.max(0, Math.trunc(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The five leaderboards the app shows, as players see them.
 *
 * The panel could only reach these as JSON before, which made "why is this
 * player top of the streaks board" a question you answered by reading a URL.
 */
export function registerBoards(router, { profiles }) {
  router.get('/boards', (req, res) => {
    const board = BOARDS.includes(String(req.query.board)) ? String(req.query.board) : BOARDS[0];
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date ?? '')) ? String(req.query.date) : todayUtc();
    const data = profiles.leaderboard(board, { date, limit: BOARD_SIZE });
    res.render('boards', {
      title: 'Leaderboards',
      boards: BOARDS.map((id) => ({ id, ...BOARD_LABELS[id] })),
      board: { id: board, ...BOARD_LABELS[board] },
      date,
      today: todayUtc(),
      data,
      clockText,
      size: BOARD_SIZE,
    });
  });
}
