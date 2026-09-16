import express from 'express';

export const SUPPORT_EMAIL = 'support@koydam.com';

/** The privacy policy and support page the App Store listing links to. */
export function legalRouter({ assetVersion }) {
  const router = express.Router();

  const page = (view, title) => (_req, res) => {
    // Public and the same for everyone; an hour keeps them cheap and still current.
    res.set('Cache-Control', 'public, max-age=3600');
    res.render(`legal/${view}`, { title, assetVersion, supportEmail: SUPPORT_EMAIL });
  };

  router.get('/privacy', page('privacy', 'Privacy policy'));
  router.get('/support', page('support', 'Support'));

  return router;
}
