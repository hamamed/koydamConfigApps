import { connectPool } from '../connect.js';
import { dayToDate, parseDay, todayUtc } from '../daily.js';
import { LIST_NAMES } from '../daily-games.js';

const LIST_LABELS = Object.freeze({ guess: 'كلمات خمّن الكلمة', wheel: 'مجموعات عجلة الحروف' });

/**
 * The day's games (contract §6): a preview of any date's set, the two word
 * lists the wheel and the guess take their words from, and where the other two
 * find theirs — فقاعات الكلمات on the pictures, وصّل الحروف in the bank and in
 * the proverbs of قوافي.
 */
export function registerDailyGames(router, { dailyGames, pictures = null, repo = null, lab = null, wordSearchDays = null }) {
  /** Titles of the bank with enough short answers to fill a وصّل الحروف board. */
  function connectTitles() {
    if (!repo) return 0;
    const byTitle = new Map();
    for (const entry of connectPool(repo.listQuestions())) {
      if (entry.title) byTitle.set(entry.title, (byTitle.get(entry.title) ?? 0) + 1);
    }
    return [...byTitle.values()].filter((n) => n >= 3).length;
  }

  const render = (res, { date, listErrors = {}, drafts = {} }) => {
    const { day } = parseDay(date);
    const lists = dailyGames.lists();
    for (const name of LIST_NAMES) {
      if (drafts[name] !== undefined) lists[name] = { ...lists[name], text: drafts[name], problems: listErrors[name] ?? [] };
    }
    res.render('daily-games', {
      title: 'ألعاب اليوم',
      date,
      previous: dayToDate(day - 1),
      next: dayToDate(day + 1),
      today: todayUtc(),
      set: dailyGames.forDate(date),
      // The board of the day is a rung like the rest, so it is previewed here too.
      wordSearch: wordSearchDays?.boardFor?.(date) ?? null,
      lists,
      labels: LIST_LABELS,
      // The two games whose content is a bank rather than a list.
      banks: {
        pictures: pictures?.counts() ?? { total: 0, published: 0 },
        titles: connectTitles(),
        proverbs: (lab?.riddles() ?? []).filter((riddle) => String(riddle?.emoji ?? '').trim()).length,
      },
    });
  };

  router.get('/daily-games', (req, res) => {
    const asked = parseDay(String(req.query.date ?? ''));
    render(res, { date: asked?.date ?? todayUtc() });
  });

  router.post('/daily-games/lists/:name', (req, res) => {
    const { name } = req.params;
    if (!LIST_NAMES.includes(name)) return res.redirect('/admin/daily-games');
    const result = dailyGames.saveList(name, req.body.body);
    if (result.error) {
      res.locals.flash = { type: 'danger', message: `${LIST_LABELS[name]}: ${result.error}` };
      return render(res, { date: todayUtc(), listErrors: { [name]: result.problems }, drafts: { [name]: String(req.body.body ?? '') } });
    }
    req.flash('success', `${LIST_LABELS[name]} saved: ${result.count} in use. Days not played yet follow the new list.`);
    res.redirect('/admin/daily-games');
  });

  router.post('/daily-games/lists/:name/reset', (req, res) => {
    const { name } = req.params;
    if (LIST_NAMES.includes(name) && dailyGames.resetList(name)) {
      req.flash('success', `${LIST_LABELS[name]} are back to the built-in list.`);
    }
    res.redirect('/admin/daily-games');
  });
}
