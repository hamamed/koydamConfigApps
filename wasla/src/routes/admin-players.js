import { barChart } from '../charts.js';
import { RETENTION_DAYS } from '../events.js';

const HELP_LABELS = {
  revealLetter: 'Reveal a letter',
  removeLetters: 'Remove 3 letters',
  solveWord: 'Solve the word',
  unzoomImage: 'Zoom out picture',
  unblurImage: 'Sharpen picture',
  askFriend: 'Ask a friend',
};

/** The players dashboard. */
export function registerPlayers(router, { players }) {
  router.get('/players', (_req, res) => {
    const data = players.dashboard();
    const chart = barChart(
      data.perDay.map((d) => ({ label: `${d.date.slice(8, 10)}/${d.date.slice(5, 7)}`, value: d.players, title: `${d.date}: ${d.players} player(s)` })),
      { label: 'Players per day, last 30 days' },
    );
    res.render('players', { title: 'Players', ...data, chart, helpLabels: HELP_LABELS, retentionDays: RETENTION_DAYS });
  });
}
