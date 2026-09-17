import { dayToDate, parseDay, todayUtc } from '../daily.js';
import { LIST_NAMES } from '../daily-games.js';

const LIST_LABELS = Object.freeze({ guess: 'Guess words', wheel: 'Wheel sets' });

/**
 * The five daily games (contract §6): a preview of any date's set, and the two
 * word lists that the wheel and the guess game take their words from.
 */
export function registerDailyGames(router, { dailyGames }) {
  const render = (res, { date, listErrors = {}, drafts = {} }) => {
    const { day } = parseDay(date);
    const lists = dailyGames.lists();
    for (const name of LIST_NAMES) {
      if (drafts[name] !== undefined) lists[name] = { ...lists[name], text: drafts[name], problems: listErrors[name] ?? [] };
    }
    res.render('daily-games', {
      title: 'Daily games',
      date,
      previous: dayToDate(day - 1),
      next: dayToDate(day + 1),
      today: todayUtc(),
      set: dailyGames.forDate(date),
      lists,
      labels: LIST_LABELS,
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
