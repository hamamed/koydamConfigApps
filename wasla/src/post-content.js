/**
 * What a post of a question says and shows — shared by the «منشور اليوم» page
 * and the scheduled posts, so both put out the same thing.
 */

/** The fields the drawing needs (public/js/post-draw.js). The answer is never among them. */
export function postFor(question, { site, appStoreUrl = '' }) {
  return {
    id: question.id,
    title: question.title || '',
    clue: question.clue || '',
    letters: [...(question.playAnswer || question.answer)].length,
    image: question.imageFile ? `/media/questions/${question.imageFile}` : null,
    credit: question.imageFile ? `${question.imageAuthor} · ${question.imageLicence}` : '',
    site,
    store: Boolean(appStoreUrl),
  };
}

/** The words to post with it: the question, the call to play, the link, the credit and the tags. */
export function captionFor(question, { site, appStoreUrl = '' }) {
  const ask = question.imageFile ? 'ما هذا؟ 🤔' : `${question.clue} 🤔`;
  const credit = question.imageFile ? `\n📷 ${question.imageAuthor} · ${question.imageLicence}` : '';
  const store = appStoreUrl ? `\n📲 حمّلها مجاناً من App Store: ${appStoreUrl}` : '';
  return `${ask}\n${[...(question.playAnswer || question.answer)].length} حروف — اكتب جوابك في التعليقات، وتحقّق منه في شبّك 👇\nhttps://${site}${store}${credit}\n#شبّك #كلمات_متقاطعة #ألغاز`;
}
