import { config } from '../config.js';

/**
 * «منشور اليوم»: a question drawn as ready-made images for the game's pages — a
 * square post and a tall story — made in the browser (public/js/post-image.js),
 * so the server needs no image library. The answer is never on the image: it is
 * the puzzle, and the post sends people to the game for it.
 */
export function registerPost(router, { repo, siteSettings = null }) {
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
      askedId,
      question,
      post: question && {
        id: question.id,
        title: question.title || '',
        clue: question.clue || '',
        letters: [...(question.playAnswer || question.answer)].length,
        image: question.imageFile ? `/media/questions/${question.imageFile}` : null,
        credit: question.imageFile ? `${question.imageAuthor} · ${question.imageLicence}` : '',
        site,
        store: Boolean(appStoreUrl),
      },
      caption: question ? caption(question, site, appStoreUrl) : '',
    });
  });
}

/** The words to post with it: the question, the call to play, the link and the tags. */
function caption(question, site, appStoreUrl = '') {
  const ask = question.imageFile ? 'ما هذا؟ 🤔' : `${question.clue} 🤔`;
  const credit = question.imageFile ? `\n📷 ${question.imageAuthor} · ${question.imageLicence}` : '';
  const store = appStoreUrl ? `\n📲 حمّلها مجاناً من App Store: ${appStoreUrl}` : '';
  return `${ask}\n${[...(question.playAnswer || question.answer)].length} حروف — اكتب جوابك في التعليقات، وتحقّق منه في شبّك 👇\nhttps://${site}${store}${credit}\n#شبّك #كلمات_متقاطعة #ألغاز`;
}
