/**
 * What a question shows above its clue: nothing, a picture, a few emoji, or a
 * sound. The clue is always there; the type says which extra the app draws.
 */

export const QUESTION_TYPES = ['text', 'image', 'emoji', 'audio'];
export const MAX_EMOJI = 8;

/** The media each type cannot do without, for the error when it is missing. */
export const TYPE_NEEDS = {
  image: ['imageFile', 'An image question needs a picture.'],
  emoji: ['emoji', 'An emoji question needs its emoji.'],
  audio: ['audioFile', 'An audio question needs an audio file.'],
};

/**
 * The type a question has when nobody chose one: the richest media it carries.
 * A sound usually comes with a picture as its cover, not the other way round.
 */
export function deriveType({ audioFile, imageFile, emoji } = {}) {
  if (audioFile) return 'audio';
  if (imageFile) return 'image';
  if (emoji) return 'emoji';
  return 'text';
}

/** Emoji as stored: spaces between them mean nothing on a phone. */
export function normalizeEmoji(raw) {
  return String(raw ?? '').replace(/\s+/g, '');
}

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

// A grapheme counts as one emoji when it draws as a picture: a pictographic
// character, a flag's regional indicators, or a keycap (1️⃣ holds a digit, and
// is still an emoji because of U+20E3).
const PICTURE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;
const LETTER = /\p{L}/u;

/** Why an emoji string cannot be used, or null. Expects a normalised string. */
export function emojiProblem(emoji) {
  const graphemes = [...segmenter.segment(emoji ?? '')].map((s) => s.segment);
  if (!graphemes.length) return 'Add at least one emoji.';
  if (!graphemes.every((g) => PICTURE.test(g) && !LETTER.test(g))) {
    return 'The emoji field takes only emoji — no letters, digits or punctuation.';
  }
  if (graphemes.length > MAX_EMOJI) return `Use at most ${MAX_EMOJI} emoji.`;
  return null;
}
