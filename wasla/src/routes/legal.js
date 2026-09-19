import express from 'express';

export const SUPPORT_EMAIL = 'support@koydam.com';

/** The privacy policy, support page and picture credits the App Store listing links to. */
export function legalRouter({ assetVersion, repo = null }) {
  const router = express.Router();

  const page = (view, title) => (_req, res) => {
    // Public and the same for everyone; an hour keeps them cheap and still current.
    res.set('Cache-Control', 'public, max-age=3600');
    res.render(`legal/${view}`, { title, assetVersion, supportEmail: SUPPORT_EMAIL });
  };

  router.get('/privacy', page('privacy', 'Privacy policy'));
  router.get('/support', page('support', 'Support'));

  // Photographers and licences for every picture in the game — what CC BY and CC BY-SA ask for.
  if (repo) {
    router.get('/credits', (_req, res) => {
      res.set('Cache-Control', 'public, max-age=3600');
      const credits = repo.credited().map((q) => ({
        answer: q.answer, title: q.title, author: q.imageAuthor, licence: q.imageLicence, source: q.imageSource,
      }));
      res.render('legal/credits', { title: 'Picture credits', assetVersion, supportEmail: SUPPORT_EMAIL, credits });
    });
  }

  return router;
}
