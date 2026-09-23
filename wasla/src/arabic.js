/**
 * The rules an answer has to follow before it can go in a grid.
 *
 * One cell holds one letter, and the player spells the answer from a bank of
 * loose letters. So an answer is stored bare: no harakat (a player cannot tap a
 * fatha) and no tatweel (it is decoration, not a letter). A name of several
 * words keeps one space between them (نجيب محفوظ), to be shown as it is written;
 * the space is dropped from the played form, since a crossword has no blank cell
 * inside a word. Letter limits count letters, not spaces.
 */

export const MIN_LETTERS = 2;
export const MAX_LETTERS = 20;

// Harakat, shadda, sukun, superscript alef and Quranic marks; then tatweel.
const MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
// The Arabic letters, plus alef wasla (ٱ), which is written but played as ا.
const ARABIC_LETTER = /^[\u0621-\u063A\u0641-\u064A\u0671]$/u;

/** The answer as it is stored and compared. */
export function normalizeAnswer(raw) {
  return String(raw ?? '').replace(MARKS, '').trim().replace(/\s+/g, ' ');
}

/**
 * Letter forms a player does not tell apart, folded to the one on the tile.
 *
 * The letter bank has one alef, one waw and one yaa, and two crossing words
 * must agree on the letter in their shared cell — so أسد is played as اسد, and
 * it can cross امل. The admin still types the word as it is spelled; that is
 * what the app shows once it is solved. ء and ة are real letters on their own
 * tiles and are left alone.
 */
const PLAY_FOLDS = new Map([
  ['\u0623', '\u0627'], // أ
  ['\u0625', '\u0627'], // إ
  ['\u0622', '\u0627'], // آ
  ['\u0671', '\u0627'], // ٱ
  ['\u0624', '\u0648'], // ؤ
  ['\u0626', '\u064A'], // ئ
  ['\u0649', '\u064A'], // ى
]);
const FOLDABLE = new RegExp(`[${[...PLAY_FOLDS.keys()].join('')}]`, 'g');

/** The answer as it is played: laid out, crossed and sent to the app. */
export function foldForPlay(answer) {
  return String(answer ?? '').replace(/\s+/g, '').replace(FOLDABLE, (ch) => PLAY_FOLDS.get(ch));
}

/** One entry per grid cell. */
export function letters(answer) {
  return [...answer];
}

/** Why an answer cannot be used, or null when it can. Expects a normalised answer. */
/**
 * An answer without its definite article — «الشمس» → «شمس» — or null when
 * taking it off would not leave an answer: a phrase (where «ال» belongs to the
 * sentence), a word that does not carry one, or a stump of two letters.
 *
 * Whether a particular answer *should* lose it is a judgement about the word,
 * not about its letters; this only says what the shorter form would be.
 */
export function withoutArticle(answer) {
  const text = String(answer ?? '').trim();
  if (!text.startsWith('ال') || text.includes(' ')) return null;
  const bare = text.slice(2);
  return letters(bare).length >= 3 ? bare : null;
}

export function answerProblem(answer) {
  const list = letters(String(answer ?? '').replace(/ /g, ''));
  if (list.length === 0) return 'An answer is required.';
  if (!list.every((ch) => ARABIC_LETTER.test(ch))) {
    return 'An answer may only contain Arabic letters — no Latin letters, digits or punctuation.';
  }
  if (list.length < MIN_LETTERS) return `An answer needs at least ${MIN_LETTERS} letters.`;
  if (list.length > MAX_LETTERS) return `An answer can have at most ${MAX_LETTERS} letters.`;
  return null;
}
