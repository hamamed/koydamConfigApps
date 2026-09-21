import { parseDay } from '../daily.js';
import { CLOSE_THEME_WORDS, MIN_THEME_WORDS } from '../wordsearch-daily.js';

/**
 * The word search's themes: which question titles can make a board, which are
 * excluded from the rotation, and which are close. Boards themselves are
 * planned and previewed on the Daily puzzle page.
 */
export function registerWordSearch(router, { wordSearch }) {
  router.get('/wordsearch', (req, res) => {
    // The old preview link (?date=) now lives on the daily puzzle page.
    const asked = parseDay(String(req.query.date ?? ''));
    if (asked) return res.redirect(`/admin/daily/${asked.date}`);

    const themes = wordSearch.themes();
    const eligible = themes.filter((t) => t.eligible);
    res.render('wordsearch', {
      title: 'مواضيع البحث',
      eligible,
      close: themes.filter((t) => !t.eligible && t.words.length >= CLOSE_THEME_WORDS),
      playableCount: eligible.filter((t) => !t.excluded).length,
      minWords: MIN_THEME_WORDS,
    });
  });

  router.post('/wordsearch/exclude', (req, res) => {
    const excluded = req.body.excluded === '1';
    const result = wordSearch.setExcluded(req.body.title, excluded);
    const title = String(req.body.title ?? '').trim();
    req.flash(result.error ? 'danger' : 'success', result.error
      ?? (excluded
        ? `“${title}” is no longer used for new days. Days already planned with it keep their boards.`
        : `“${title}” is back in the rotation.`));
    res.redirect('/admin/wordsearch');
  });
}
