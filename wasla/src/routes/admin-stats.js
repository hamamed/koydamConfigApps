import { HARD_MIN_OPENS, HARD_SOLVE_RATE, HELPS, RETENTION_DAYS } from '../events.js';

const SORTS = ['answer', 'opens', 'solves', 'solveRate', 'avgSeconds', 'helps', 'left', 'devices'];

/** Gameplay stats per question and per level. */
export function registerStats(router, { events }) {
  router.get('/stats', (req, res) => {
    const sort = SORTS.includes(req.query.sort) ? req.query.sort : 'opens';
    const dir = req.query.dir === 'asc' ? 'asc' : 'desc';
    const hard = req.query.hard === '1';

    res.render('stats', {
      title: 'Stats',
      overview: events.overview(),
      questions: events.questionStats({ sort, dir, hard }),
      levels: events.levelStats(),
      helps: HELPS,
      sort,
      dir,
      hard,
      hardRule: { rate: HARD_SOLVE_RATE, opens: HARD_MIN_OPENS },
      retentionDays: RETENTION_DAYS,
    });
  });
}
