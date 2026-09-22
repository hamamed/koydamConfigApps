import { parseDay } from '../daily.js';
import { CLOSE_THEME_WORDS, MIN_THEME_WORDS, WORDS_BY_SIZE } from '../wordsearch-daily.js';
import { MAX_SIZE } from '../wordsearch.js';

/**
 * The word search's themes: which question titles the daily board may be built
 * from. The page is a chooser — a box per title, ticked when it is in — and one
 * save writes the whole choice. Titles too thin for a board are listed apart,
 * with how many questions they still need. Boards themselves are planned and
 * previewed on the Daily puzzle page.
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
      // What the largest board asks for: a theme under it can only take a
      // smaller day, so the chooser says so beside the count.
      fullWords: WORDS_BY_SIZE[MAX_SIZE][0],
    });
  });

  /** The whole choice at once: every ticked title is in, every other one is out. */
  router.post('/wordsearch/choose', (req, res) => {
    const result = wordSearch.setPlayableTitles(req.body.titles);
    req.flash(result.error ? 'danger' : 'success', result.error
      ?? `حُفظ الاختيار: ${result.used} فئة في البحث اليومي، و${result.excluded} خارجه. `
        + 'الأيام المخطَّطة تحتفظ بشبكاتها.');
    res.redirect('/admin/wordsearch');
  });
}
