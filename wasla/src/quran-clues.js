/**
 * The clue for a "complete the ayah" question.
 *
 * The bank's Quranic questions used to be written by cutting the ayah at the
 * answer and putting «…» there, so the blank was always the last thing on the
 * line. Two words of context is thin, and a blank that is always last is a
 * pattern a player learns instead of the verse. A clue here shows the ayah it
 * came from, with the answer blanked wherever it happens to sit, and stops at
 * the end of that ayah — the verse before and the verse after are not shown,
 * however well they would read.
 *
 * Nothing in this file fetches anything. It is given the ayah and the answer
 * and returns the line; `scripts/rebuild-quran-clues.js` is what goes looking.
 */

import { foldForPlay, normalizeAnswer } from './arabic.js';

/** Where the blank goes. */
export const BLANK = '…';

/**
 * Most of an ayah, in words. Nine tenths of the ayat the bank quotes are
 * shorter than this, so the cap only bites on the handful of long ones — where
 * a whole ayah would be a paragraph, not a clue.
 */
export const MAX_WORDS = 14;

/**
 * The fewest words of the verse a clue may show beside the blank.
 *
 * Some first ayat are barely longer than the answer — العصر 1 is «وَالْعَصْرِ»
 * and nothing else — so blanking the answer would leave a clue that is only the
 * blank. Where that happens the basmala is kept: it says which surah's opening
 * this is, which is more than an empty line says.
 *
 * One word is enough. Several ayat are two words long (البلد 10 is
 * «وَهَدَيْنَاهُ النَّجْدَيْنِ»), and showing the one that is not the answer is
 * showing the whole verse — which is all a clue may show.
 */
export const MIN_CONTEXT = 1;

/**
 * The basmala, by its words rather than by its spelling.
 *
 * The edition writes it «بِّسْمِ» at the head of التين and puts a byte order
 * mark before it in الفاتحة, so matching the text itself misses two surahs out
 * of the hundred and something it is meant to catch.
 */
const BASMALA = ['بسم', 'الله', 'الرحمن', 'الرحيم'];
/** The hizb mark, which is a scribe's sign and not a word of the verse. */
const HIZB = /^\s*۞\s*/u;

/** A word as it is compared: no marks, and letters a player cannot tell apart folded. */
export const key = (text) => foldForPlay(normalizeAnswer(text));

/** Every whitespace-separated piece of a line, marks included. */
const tokens = (text) => String(text ?? '').split(/\s+/u).filter(Boolean);

/**
 * The words of a line, with the waqf marks and the ayah bullet dropped.
 *
 * ۖ ۛ ۚ and the like are written between words and are counted by nobody as
 * words; a clue keeps them, because they are part of the verse as it is read,
 * but they must not take up any of the room a clue has.
 */
export function meaningfulWords(text) {
  return tokens(text).filter((word) => key(word) !== '');
}

/**
 * The ayah as a clue shows it: without the basmala this edition carries on a
 * first ayah, and without the hizb mark.
 *
 * The basmala stays when the answer is inside it — «الرحيم» is a question about
 * the opening of the Fatiha, and cutting it would leave nothing to complete.
 */
export function ayahForClue(text, answer) {
  // A byte order mark rides at the head of the first ayah of the first surah.
  const trimmed = String(text ?? '').replace(/^\uFEFF/u, '').replace(HIZB, '').trim();
  const pieces = trimmed.split(/\s+/u).filter(Boolean);
  const words = pieces.filter((piece) => key(piece) !== '');
  const opensWithBasmala = BASMALA.every((word, i) => key(words[i] ?? '') === word);
  if (!opensWithBasmala) return trimmed;
  // It stays when the answer is inside it — «الرحيم» is a question about the
  // opening of the Fatiha, and cutting it would leave nothing to complete.
  const wanted = meaningfulWords(answer).map(key);
  if (wanted.some((word) => BASMALA.includes(word))) return trimmed;
  // And it stays when the rest of the ayah is too short to be a clue on its own.
  if (words.length - BASMALA.length - wanted.length < MIN_CONTEXT) return trimmed;

  let seen = 0;
  const rest = pieces.filter((piece) => {
    if (key(piece) === '') return seen >= BASMALA.length;
    seen += 1;
    return seen > BASMALA.length;
  });
  return rest.join(' ');
}

/**
 * The stretch of an over-long ayah that a clue shows: the blank, and as much on
 * either side as `MAX_WORDS` allows.
 *
 * It leans on whichever side has room, so a blank near the start of a long ayah
 * still gets its context — from after it, since there is none before. The count
 * is of words; the marks between them ride along for free.
 */
function window(pieces, blankAt) {
  const isWord = (piece) => key(piece) !== '';
  const total = pieces.filter(isWord).length;
  if (total <= MAX_WORDS) return pieces;

  // Where the blank sits, counted in words rather than in pieces.
  const blankWord = pieces.slice(0, blankAt).filter(isWord).length;
  // A blank near the opening is shown with the opening: a verse that starts
  // where it starts reads better than one snipped a word short of it.
  const firstWord = blankWord < MAX_WORDS
    ? 0
    : Math.min(blankWord - Math.floor((MAX_WORDS - 1) / 2), total - MAX_WORDS);

  const kept = [];
  let seen = 0;
  for (const piece of pieces) {
    const word = isWord(piece);
    if (word && seen >= firstWord + MAX_WORDS) break;
    // A mark only belongs in the window if a word it sits between is there too.
    if (!word ? kept.length > 0 : seen >= firstWord) kept.push(piece);
    if (word) seen += 1;
  }
  return atPauses(kept, firstWord === 0, seen >= total);
}

/**
 * Drops a leading word that is the answer itself.
 *
 * A few verses say the same word twice — المائدة 32 has «جَمِيعًا» at the end of
 * both halves — and a window cut into the middle of one can open on the word it
 * is asking for. Only a window that already starts mid-verse is trimmed; where
 * the verse itself opens with that word, it is the verse, not a giveaway.
 */
function trimGiveaway(shown, whole, wanted) {
  if (wanted.length !== 1 || shown[0] === whole[0]) return shown;
  if (key(shown[0]) !== wanted[0]) return shown;
  const rest = shown.slice(1);
  const words = rest.filter((piece) => key(piece) !== '').length - 1;
  return words >= MIN_CONTEXT ? rest : shown;
}

/**
 * Trims a window back to the verse's own pauses.
 *
 * The waqf marks — ۖ ۗ ۚ ۘ ۛ — are where a reader stops, so they are the only
 * places a long verse can be cut without the clue beginning or ending in the
 * middle of a phrase. A cut that would leave too little of the verse is not
 * made: a clue that reads awkwardly beats one that says nothing.
 */
function atPauses(pieces, atStart, atEnd) {
  const isWord = (piece) => key(piece) !== '';
  const enough = (list) => list.filter(isWord).length - 1 >= MIN_CONTEXT;
  const blank = (list) => list.indexOf(BLANK);
  let kept = pieces;

  if (!atStart) {
    const pause = kept.findIndex((piece, i) => !isWord(piece) && i < blank(kept));
    const trimmed = pause === -1 ? kept : kept.slice(pause + 1);
    if (pause !== -1 && enough(trimmed)) kept = trimmed;
  }
  if (!atEnd) {
    const after = blank(kept);
    let pause = -1;
    kept.forEach((piece, i) => { if (!isWord(piece) && i > after) pause = i; });
    const trimmed = pause === -1 ? kept : kept.slice(0, pause);
    if (pause !== -1 && enough(trimmed)) kept = trimmed;
  }
  // However it was cut, a mark left hanging off either end is not a word.
  while (kept.length && !isWord(kept[kept.length - 1])) kept = kept.slice(0, -1);
  while (kept.length && !isWord(kept[0])) kept = kept.slice(1);
  return kept;
}

/**
 * The clue for an answer at `at` in `ayah`, named for its surah.
 *
 * Returns null when the answer is not where it is said to be — a caller that
 * cannot find its own answer has a question to fix, not a clue to write.
 */
export function buildClue({ ayah, answer, at, surah }) {
  const text = ayahForClue(ayah, answer);
  const pieces = tokens(text);
  const wanted = meaningfulWords(answer).map(key);
  // `at` counts words of the whole ayah; the basmala may have gone since.
  const shift = meaningfulWords(ayah).length - meaningfulWords(text).length;
  const startWord = at - shift;
  if (startWord < 0) return null;

  // The pieces the answer occupies, found by counting words past the marks.
  const wordAt = [];
  pieces.forEach((piece, i) => { if (key(piece) !== '') wordAt.push(i); });
  if (startWord + wanted.length > wordAt.length) return null;
  const answerPieces = wanted.map((_, i) => wordAt[startWord + i]);
  if (!wanted.every((word, i) => key(pieces[answerPieces[i]]) === word)) return null;

  const first = answerPieces[0];
  const last = answerPieces[answerPieces.length - 1];
  const blanked = [...pieces.slice(0, first), BLANK, ...pieces.slice(last + 1)];
  const shown = trimGiveaway(window(blanked, first), blanked, wanted);
  return `${shown.join(' ')} ﴿${surah}﴾`;
}
