import express from 'express';

import { config } from '../config.js';
import { SUPPORT_EMAIL } from './legal.js';
import { createPanelIcons } from '../panel-icons.js';
import { landingJsonLd, pageMeta } from '../seo.js';
import { LADDER_RUNGS } from '../daily-ladder.js';
import { BOARDS } from '../profiles.js';
import { BOARD_LABELS } from './admin-boards.js';

/**
 * The icons this page draws — the game's own, from the pack the app uses.
 *
 * Named one by one rather than serving the folder: the pack may be used in a
 * project but not handed out, and a page is a use of eight pictures, not an
 * offer of the set.
 */
export const SITE_ICONS = Object.freeze([
  'grid-3x3', 'calendar-days', 'fire', 'trophy', 'message-circle-question', 'shield',
  'gamepad-2', 'star',
]);

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
  const icons = createPanelIcons();

  /** One of the page's own icons; anything else is not here. */
  router.get('/assets/site/icon/:name.svg', (req, res) => {
    const name = String(req.params.name);
    const file = SITE_ICONS.includes(name) ? icons.file(name) : null;
    if (!file) return res.status(404).end();
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=604800').sendFile(file);
  });

  router.get('/', (_req, res) => {
    const counts = repo ? repo.counts() : { published: 0, questions: 0 };
    res.set('Cache-Control', 'public, max-age=600');
    const meta = pageMeta(config.siteBase, '/');
    const appStoreUrl = siteSettings.appStoreUrl();
    res.render('site/landing', {
      title: meta.title,
      seo: { ...meta, base: config.siteBase, jsonLd: landingJsonLd({ base: config.siteBase, description: meta.description, appStoreUrl }) },
      assetVersion,
      supportEmail: SUPPORT_EMAIL,
      appStoreUrl,
      playUrl: siteSettings.playUrl(),
      levels: counts.published,
      questions: counts.questions,
      // Read from the game itself, so the page cannot drift from the panel and the app.
      boards: BOARDS.map((id) => BOARD_LABELS[id].ar),
      rungs: LADDER_RUNGS,
      // With the pack absent (a checkout that has never seen it) the page
      // simply carries no icons rather than a row of broken pictures.
      hasIcons: SITE_ICONS.every((name) => Boolean(icons.file(name))),
      iconUrl: (name) => `/assets/site/icon/${name}.svg?v=${config.assetVersion}`,
    });
  });

  return router;
}
