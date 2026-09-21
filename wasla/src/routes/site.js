import express from 'express';

import { SUPPORT_EMAIL } from './legal.js';

/**
 * The page someone lands on: what the game is, what is in it, and where to get
 * it. Public, cached, and the only page here a player will ever see.
 *
 * The store buttons are Apple's and Google's own artwork, shown only while
 * there is a listing to send someone to — both ask that their badge is not
 * used for an app that is not on their store, and until then the page says so
 * in words instead.
 */
export function siteRouter({ assetVersion, siteSettings, repo = null, dailyGames = null }) {
  const router = express.Router();

  router.get('/', (_req, res) => {
    const counts = repo ? repo.counts() : { published: 0, questions: 0 };
    res.set('Cache-Control', 'public, max-age=600');
    res.render('site/landing', {
      title: 'شبّك · لعبة كلمات متقاطعة عربية',
      assetVersion,
      supportEmail: SUPPORT_EMAIL,
      appStoreUrl: siteSettings.appStoreUrl(),
      playUrl: siteSettings.playUrl(),
      levels: counts.published,
      questions: counts.questions,
      dailyGames: dailyGames ? 6 : 6,
    });
  });

  return router;
}
