import { withoutArticle } from '../arabic.js';
import { isNounCategory } from '../article-policy.js';

/**
 * Every answer in the bank on one page, so the words themselves can be read
 * straight through rather than one question at a time.
 *
 * The filter that matters here is «ال»: after a sweep that took the article off
 * 373 answers, the question «which ones still carry it, and should they?» needs
 * somewhere to be asked.
 *
 * The button that takes the article off is offered only where it is sensible —
 * the categories of ordinary nouns (src/article-policy.js). A proper noun keeps
 * its article, so on شخصيات تاريخية or خرائط ومواقع the row says why instead of
 * offering a one-click way to ruin the answer. It strips through the
 * repository, so levels using the answer are laid out again as any edit would.
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
        // Null when taking the article off would not leave an answer, and only
        // offered where the category's answers are ordinary nouns.
        bare: isNounCategory(q.title) ? withoutArticle(q.answer) : null,
        // Said on a row that carries «ال» but must keep it.
        keeps: !isNounCategory(q.title) && q.answer.trim().startsWith('ال'),
      }));

    res.render('answers', {
      title: 'الأجوبة',
      // So the strip button returns to the listing it was pressed on.
      currentUrl: req.originalUrl,
      rows,
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

  /** Takes «ال» off one answer, and keeps where you were looking. */
  router.post('/answers/:id/strip', (req, res) => {
    const question = repo.getQuestion(Number(req.params.id));
    const bare = question && isNounCategory(question.title) && withoutArticle(question.answer);
    if (!bare) {
      req.flash('danger', question && !isNounCategory(question.title)
        ? `«${question.answer}» في فئة أسماء علم — «ال» جزء من الجواب. عدّله من صفحة السؤال إن أردت.`
        : 'لا يمكن حذف «ال» من هذا الجواب.');
      return res.redirect(back(req));
    }
    const result = repo.updateQuestion(question.id, { answer: bare });
    if (result.error) req.flash('danger', result.error);
    else {
      const lost = result.unpublished?.length ?? 0;
      req.flash('success', `«${question.answer}» صار «${bare}».`
        + (lost ? ` وأُلغي نشر ${lost} لغزاً لم تعد كلماته تتقاطع.` : ''));
    }
    res.redirect(back(req));
  });

}
