import { barChart } from '../charts.js';
import { RETENTION_DAYS } from '../events.js';

const HELP_LABELS = {
  revealLetter: 'كشف حرف',
  removeLetters: 'حذف 3 حروف',
  solveWord: 'حل الكلمة',
  unzoomImage: 'إبعاد الصورة',
  unblurImage: 'توضيح الصورة',
  askFriend: 'اسأل صديقاً',
};

/** The players dashboard. */
export function registerPlayers(router, { players }) {
  router.get('/players', (_req, res) => {
    const data = players.dashboard();
    const chart = barChart(
      data.perDay.map((d) => ({ label: `${d.date.slice(8, 10)}/${d.date.slice(5, 7)}`, value: d.players, title: `${d.date}: ${d.players} player(s)` })),
      { label: 'اللاعبون يومياً، آخر 30 يوماً' },
    );
    res.render('players', { title: 'الأجهزة', ...data, chart, helpLabels: HELP_LABELS, retentionDays: RETENTION_DAYS });
  });
}
