import express from 'express';

import { APPLE_APP_SITE_ASSOCIATION, challengePage, parseChallenge, parseLevelNumber } from '../challenge.js';

const AASA_BODY = Buffer.from(JSON.stringify(APPLE_APP_SITE_ASSOCIATION));

/**
 * Public, no session: the challenge landing page and the file iOS fetches to
 * trust /c/* as universal links. Mounted before the panel and the 404 handler.
 */
export function challengeRouter({ repo, publicUrl, siteSettings, assetVersion }) {
  const router = express.Router();

  // Apple's CDN fetches this without following redirects, and wants JSON.
  const association = (_req, res) => {
    // setHeader, not res.set: Express's set() appends "; charset=utf-8".
    res.setHeader('Content-Type', 'application/json');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(AASA_BODY);
  };
  router.get('/.well-known/apple-app-site-association', association);
  router.get('/apple-app-site-association', association);

  router.get('/c/:level', (req, res) => {
    const level = parseLevelNumber(req.params.level);
    const published = repo.publishedLevels().length;
    // Short: a level published a minute ago should stop saying "not found" soon.
    res.set('Cache-Control', 'public, max-age=300');

    if (!level || level > published) {
      return res.status(404).render('challenge/not-found', {
        title: 'اللغز غير موجود',
        assetVersion,
        appStoreUrl: siteSettings.appStoreUrl(),
        publicUrl,
      });
    }

    const { seconds, stars } = parseChallenge(req.query);
    res.render('challenge/landing', {
      ...challengePage({ level, seconds, stars, publicUrl }),
      assetVersion,
      appStoreUrl: siteSettings.appStoreUrl(),
    });
  });

  return router;
}
