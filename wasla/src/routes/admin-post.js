import { config } from '../config.js';
import { captionFor, postFor } from '../post-content.js';

/**
 * «منشور اليوم»: a question drawn as ready-made images for the game's pages — a
 * square post and a tall story — made in the browser (public/js/post-image.js),
 * with the same drawing scheduled posts use on the server (post-render.js). The answer is never on the image: it is
 * the puzzle, and the post sends people to the game for it.
 */
export function registerPost(router, { repo, siteSettings = null, metaAccount = null, autopost = null }) {
  router.get('/post', (req, res) => {
    const kind = req.query.kind === 'text' ? 'text' : 'picture';
    const askedId = Number(req.query.id) > 0 ? Number(req.query.id) : null;
    const question = repo.questionForPost({ id: askedId, kind });
    const site = config.siteBase.replace(/^https?:\/\//, '');
    // The App Store badge goes on the images only while there is a listing to send people to.
    const appStoreUrl = siteSettings ? siteSettings.appStoreUrl() : '';
    res.render('post', {
      title: 'منشور اليوم',
      kind,
      canPublish: Boolean(metaAccount?.status().connected),
      canReel: Boolean(autopost),
      askedId,
      question,
      post: question && postFor(question, { site, appStoreUrl }),
      caption: question ? captionFor(question, { site, appStoreUrl }) : '',
    });
  });

  // The reel: the story animated, made on the server (reel-render.js) — the very
  // file a scheduled reel posts. Made on first ask, then kept for a week.
  router.get('/post/reel.mp4', async (req, res, next) => {
    if (!autopost) return next();
    try {
      const id = Number(req.query.id);
      const file = Number.isInteger(id) && id > 0
        ? await autopost.previewReel(id, { showCredit: req.query.credit !== '0', version: config.assetVersion })
        : null;
      if (!file) return res.status(404).type('text/plain').send('No reel for that question: it needs a credited picture.');
      if (req.query.download === '1') res.attachment(`chabbek-reel-${id}.mp4`);
      return res.sendFile(file, { maxAge: 0 });
    } catch (err) {
      return next(err);
    }
  });
}
