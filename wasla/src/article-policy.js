/**
 * Which categories an answer may sensibly lose «ال» from.
 *
 * In these five the answers are ordinary nouns — القلم, الشمس, السباحة — and
 * the article is decoration. Everywhere else it belongs to the answer: a
 * proverb needs it to be a sentence, and الطهطاوي, البيهقي, الجرجاني, القاهرة
 * are simply how those names are written. Offering to strip it there is
 * offering to break the answer.
 *
 * Shared by scripts/strip-article.js, which sweeps, and the Answers page,
 * which strips one at a time — so the two can never disagree about what is
 * safe to touch.
 */
export const NOUN_CATEGORIES = Object.freeze([
  'معلومات عامة', 'رياضات', 'مرادف', 'النحو والإعراب', 'شخصيات كرتونية',
]);

export const isNounCategory = (title) => NOUN_CATEGORIES.includes(String(title ?? '').trim());
