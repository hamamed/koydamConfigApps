import { config } from '../config.js';
import { captionFor, postFor } from '../post-content.js';

/**
 * «منشور اليوم»: a question drawn as ready-made images for the game's pages — a
 * square post and a tall story — made in the browser (public/js/post-image.js),
 * with the same drawing scheduled posts use on the server (post-render.js). The answer is never on the image: it is
 * the puzzle, and the post sends people to the game for it.
 */
export function registerPost(router, { repo, siteSettings = null, metaAccount = null }) {
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
      askedId,
      question,
      post: question && postFor(question, { site, appStoreUrl }),
      caption: question ? captionFor(question, { site, appStoreUrl }) : '',
    });
  });
}
