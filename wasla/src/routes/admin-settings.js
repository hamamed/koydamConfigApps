import { readAppStoreUrl, readPlayUrl } from '../site-settings.js';
import {
  DEFAULT_CONFIG, IOS_TEST_ADS, MAX_ADS_EVERY_QUESTIONS, MAX_ADS_PER_DAY, MAX_ADS_SECONDS_BETWEEN,
  MAX_REWARDED_COINS, MAX_REWARDED_PER_DAY, MAX_STARS_PER_LEVEL, MAX_STREAK_FREEZE_COST,
  MAX_WORD_SEARCH_HELP_COST, REWARD_DAYS,
} from '../app-config.js';

/** The numbers GET /api/v1/config serves. */
export function registerSettings(router, { appConfig, siteSettings, events = null, reports = null }) {
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
    maxAdsEveryQuestions: MAX_ADS_EVERY_QUESTIONS,
    maxAdsSecondsBetween: MAX_ADS_SECONDS_BETWEEN,
    maxAdsPerDay: MAX_ADS_PER_DAY,
    maxRewardedPerDay: MAX_REWARDED_PER_DAY,
    maxRewardedCoins: MAX_REWARDED_COINS,
    testAds: IOS_TEST_ADS,
    ...(error ? { flash: { type: 'danger', message: error } } : {}),
  });

  router.get('/settings', (_req, res) => render(res, appConfig.get()));

  /**
   * Zeroes the play statistics: every recorded event goes, and the Stats page
   * starts from nothing. Questions, levels and profiles are untouched — this
   * is the history of play, not the game.
   */
  router.post('/settings/stats/reset', (req, res) => {
    if (!events) return res.redirect('/admin/settings');
    const gone = events.clear();
    req.flash('success', gone
      ? `صُفّرت الإحصاءات: حُذف ${gone.toLocaleString('en')} حدثاً. الأسئلة والألغاز والحسابات لم تُمسّ.`
      : 'لا أحداث مسجَّلة أصلاً.');
    res.redirect('/admin/settings');
  });

  /** Throws away the reports already dealt with; the open ones stay. */
  router.post('/settings/reports/clear', (req, res) => {
    if (!reports) return res.redirect('/admin/settings');
    const gone = reports.clearResolved();
    req.flash('success', gone ? `حُذف ${gone} بلاغاً معالَجاً.` : 'لا بلاغات معالَجة.');
    res.redirect('/admin/settings');
  });

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
      // Ads (contract §11). Unchecked boxes are simply absent, which reads as false.
      ads: {
        enabled: body.adsEnabled,
        testMode: body.adsTestMode,
        appId: body.adsAppId,
        banner: { enabled: body.adsBannerEnabled, unitId: body.adsBannerUnitId },
        interstitial: {
          enabled: body.adsInterstitialEnabled,
          unitId: body.adsInterstitialUnitId,
          everyQuestions: body.adsInterstitialEvery,
          minSecondsBetween: body.adsInterstitialMinSeconds,
          maxPerDay: body.adsInterstitialMaxPerDay,
        },
        rewarded: {
          enabled: body.adsRewardedEnabled,
          unitId: body.adsRewardedUnitId,
          coins: body.adsRewardedCoins,
          maxPerDay: body.adsRewardedMaxPerDay,
        },
      },
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
