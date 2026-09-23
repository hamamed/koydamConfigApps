import { withoutArticle } from '../arabic.js';
import { articleNote } from '../article-policy.js';

/**
 * Every answer in the bank on one page, so the words themselves can be read
 * straight through rather than one question at a time.
 *
 * The filter that matters here is «ال»: after a sweep that took the article off
 * 373 answers, the question «which ones still carry it, and should they?» needs
 * somewhere to be asked.
 *
 * Every answer that could lose its article is offered, with the reason it might
 * want to keep one printed beside it — «اسم علم», «كلمة من مثل», «آية أو سورة».
 * The sweep (scripts/strip-article.js) obeys those reasons; this page only
 * shows them, because the person reading one answer and its clue knows more
 * than a category does. It strips through the repository, so levels using the
 * answer are laid out again as any edit would.
 */

/** الكل · فيها «ال» · بلا «ال» */
/** Rows one page draws. Five thousand answers is four megabytes of table. */
export const PAGE_ROWS = 500;

export const ARTICLE_FILTERS = Object.freeze({
  all: 'كل الأجوبة',
  with: 'تبدأ بـ«ال»',
  without: 'لا تبدأ بـ«ال»',
});

export function registerAnswers(router, { repo, titleNames }) {
  /** The listing the button was pressed on, so the page does not jump back to the top of everything. */
  const back = (req) => {
    const where = String(req.body.back ?? '').trim();
    return where.startsWith('/admin/answers') ? where : '/admin/answers';
  };

  const page = (req, res) => {
    const article = Object.keys(ARTICLE_FILTERS).includes(String(req.query.article))
      ? String(req.query.article) : 'all';
    const title = String(req.query.title ?? '').trim();
    const search = String(req.query.q ?? '').trim();

    const all = repo.listQuestions({ search, title });
    const matching = all.filter((q) => (article === 'all' ? true
      : article === 'with' ? q.answer.trim().startsWith('ال')
        : !q.answer.trim().startsWith('ال')));
    const rows = matching
      .slice(0, PAGE_ROWS)
      .map((q) => ({
        id: q.id,
        answer: q.answer,
        playAnswer: q.playAnswer,
        title: q.title ?? '',
        difficulty: q.difficulty ?? '',
        levelCount: q.levelCount,
        // Null when taking the article off would not leave an answer at all:
        // a phrase, or a stump of two letters.
        bare: withoutArticle(q.answer),
        // Why this one probably wants to keep it, if anything does.
        note: articleNote(q.title, q.answer),
      }));

    res.render('answers', {
      title: 'الأجوبة',
      // So the strip button returns to the listing it was pressed on.
      currentUrl: req.originalUrl,
      rows,
      // How many of the drawn rows may be ticked, for the bulk bar.
      strippable: rows.filter((r) => r.bare).length,
      matched: matching.length,
      shown: rows.length,
      pageRows: PAGE_ROWS,
      total: all.length,
      withArticle: all.filter((q) => q.answer.trim().startsWith('ال')).length,
      filters: ARTICLE_FILTERS,
      article,
      titles: titleNames(),
      chosenTitle: title,
      search,
      difficulties: { easy: 'سهل', medium: 'متوسط', hard: 'صعب' },
    });
  };

  router.get('/answers', page);

  /**
   * Takes «ال» off the answers ticked — or off the one whose own button was
   * pressed (`only`). Every id is put through the same two checks the page
   * used to decide whether to offer it at all, because a form can be sent with
   * anything in it.
   */
  router.post('/answers/strip', (req, res) => {
    const ids = (req.body.only ? [req.body.only] : [].concat(req.body.ids ?? []))
      .map((id) => Number(id)).filter(Number.isInteger);
    if (!ids.length) {
      req.flash('warning', 'لم تحدّد شيئاً.');
      return res.redirect(back(req));
    }

    const done = [];
    const refused = [];
    let unpublished = 0;
    for (const id of ids) {
      const question = repo.getQuestion(id);
      const bare = question && withoutArticle(question.answer);
      if (!bare) {
        refused.push(question?.answer ?? `#${id}`);
        continue;
      }
      const result = repo.updateQuestion(id, { answer: bare });
      if (result.error) refused.push(`${question.answer} (${result.error})`);
      else {
        done.push(`${question.answer} ← ${bare}`);
        unpublished += result.unpublished?.length ?? 0;
      }
    }

    // The flash holds one message, so what was done and what was refused are
    // said together — otherwise the second call silently replaces the first.
    const parts = [];
    if (done.length) {
      // One answer says which; many say how many, and name the first few.
      parts.push(done.length === 1 ? `«${done[0]}».`
        : `حُذفت «ال» من ${done.length} جواباً: ${done.slice(0, 3).join('، ')}${done.length > 3 ? '…' : ''}`);
      if (unpublished) parts.push(`وأُلغي نشر ${unpublished} لغزاً لم تعد كلماته تتقاطع.`);
    }
    if (refused.length) {
      parts.push(`تُرك ${refused.length} كما هو: ${refused.slice(0, 5).join('، ')}${refused.length > 5 ? '…' : ''}`);
    }
    req.flash(refused.length ? (done.length ? 'warning' : 'danger') : 'success', parts.join(' '));
    res.redirect(back(req));
  });

}
