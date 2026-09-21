import { readAppStoreUrl, readPlayUrl } from '../site-settings.js';
import { DEFAULT_CONFIG, MAX_STARS_PER_LEVEL, MAX_STREAK_FREEZE_COST, MAX_WORD_SEARCH_HELP_COST, REWARD_DAYS } from '../app-config.js';

/** The numbers GET /api/v1/config serves. */
export function registerSettings(router, { appConfig, siteSettings }) {
  const render = (res, values, error = null, appStoreUrl = siteSettings.storedAppStoreUrl(), playUrl = siteSettings.playUrl()) => res.render('settings', {
    title: 'الإعدادات',
    values,
    appStoreUrl,
    playUrl,
    envAppStoreUrl: siteSettings.envAppStoreUrl,
    defaults: DEFAULT_CONFIG,
    rewardDays: REWARD_DAYS,
    maxStarsPerLevel: MAX_STARS_PER_LEVEL,
    maxStreakFreezeCost: MAX_STREAK_FREEZE_COST,
    maxWordSearchHelpCost: MAX_WORD_SEARCH_HELP_COST,
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
      streakFreezeCost: body.streakFreezeCost,
      wordSearchHelpCosts: { revealLetter: body.wordSearchRevealLetter, revealWord: body.wordSearchRevealWord },
      dailyGameCoins: body.dailyGameCoins,
      dailyAllGamesBonus: body.dailyAllGamesBonus,
    };
    const appStoreUrl = String(body.appStoreUrl ?? '');
    const playUrl = String(body.playUrl ?? '');
    const link = readAppStoreUrl(appStoreUrl);
    const play = readPlayUrl(playUrl);
    // A refused form comes back with what was typed, not the stored values.
    if (link.error) return render(res, input, link.error, appStoreUrl, playUrl);
    if (play.error) return render(res, input, play.error, appStoreUrl, playUrl);
    const result = appConfig.save(input);
    if (result.error) return render(res, input, result.error, appStoreUrl, playUrl);
    siteSettings.saveAppStoreUrl(appStoreUrl);
    siteSettings.savePlayUrl(playUrl);
    req.flash('success', 'حُفظت الإعدادات. يقرأها التطبيق عند تشغيله القادم.');
    res.redirect('/admin/settings');
  });
}
