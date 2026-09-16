import { todayUtc } from '../daily.js';

export const DAILY_DAYS_SHOWN = 14;

/** The daily puzzle calendar. */
export function registerDaily(router, { repo, daily }) {
  router.get('/daily', (_req, res) => {
    const today = todayUtc();
    const days = daily.upcoming(today, DAILY_DAYS_SHOWN);
    const published = repo.publishedLevels();
    const ids = repo.publishedLevelIds();
    // id → "3 · title", for the selects and for naming the automatic pick.
    const levels = ids.map((id, i) => ({ id, number: i + 1, title: published[i].title }));
    const byId = new Map(levels.map((l) => [l.id, l]));
    const titleOf = (id) => repo.getLevel(id)?.title ?? `#${id}`;

    res.render('daily', {
      title: 'Daily puzzle',
      today,
      days,
      levels,
      byId,
      later: daily.scheduledAfter(days.at(-1).date).map((d) => ({ ...d, title: titleOf(d.levelId), published: byId.has(d.levelId) })),
    });
  });

  const schedule = (req, res, date) => {
    const levelId = String(req.body.levelId ?? '');
    if (!levelId) {
      daily.clear(date);
      req.flash('success', `${date} is back to the automatic pick.`);
      return res.redirect('/admin/daily');
    }
    const result = daily.schedule(date, levelId);
    req.flash(result.error ? 'danger' : 'success', result.error ?? `Scheduled the puzzle for ${date}.`);
    res.redirect('/admin/daily');
  };

  router.post('/daily', (req, res) => schedule(req, res, String(req.body.date ?? '')));

  router.post('/daily/:date', (req, res) => schedule(req, res, req.params.date));

  router.post('/daily/:date/clear', (req, res) => {
    daily.clear(req.params.date);
    req.flash('success', `${req.params.date} is back to the automatic pick.`);
    res.redirect('/admin/daily');
  });
}
