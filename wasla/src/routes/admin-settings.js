import { DEFAULT_CONFIG, MAX_STARS_PER_LEVEL, REWARD_DAYS } from '../app-config.js';

/** The numbers GET /api/v1/config serves. */
export function registerSettings(router, { appConfig }) {
  const render = (res, values, error = null) => res.render('settings', {
    title: 'Settings',
    values,
    defaults: DEFAULT_CONFIG,
    rewardDays: REWARD_DAYS,
    maxStarsPerLevel: MAX_STARS_PER_LEVEL,
    ...(error ? { flash: { type: 'danger', message: error } } : {}),
  });

  router.get('/settings', (_req, res) => render(res, appConfig.get()));

  router.post('/settings', (req, res) => {
    const body = req.body;
    const rewards = Array.isArray(body.dailyRewards) ? body.dailyRewards : [body.dailyRewards];
    const input = {
      dailyRewards: rewards,
      dailyPuzzleCoins: body.dailyPuzzleCoins,
      streakBonusPerDay: body.streakBonusPerDay,
      streakBonusMax: body.streakBonusMax,
      timer: { secondsPerWord: body.timerSecondsPerWord, bonusCoins: body.timerBonusCoins },
      reminderHour: body.reminderHour,
      starsPerLevel: body.starsPerLevel,
    };
    const result = appConfig.save(input);
    // A refused form comes back with what was typed, not the stored values.
    if (result.error) return render(res, input, result.error);
    req.flash('success', 'Settings saved. The app picks them up on its next launch.');
    res.redirect('/admin/settings');
  });
}
