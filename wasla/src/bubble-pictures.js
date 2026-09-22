/**
 * The pictures فقاعات الكلمات is played on (contract §10).
 *
 * A round is a picture and the words that belong to it — بلايستيشن: ألعاب،
 * ذراع، سوني، أسلاك. The game cuts those words into pieces and mixes them, so
 * the picture says what to look for and the board says how to spell it.
 *
 * Nothing in the question bank knows what belongs to a picture, so every round
 * is written by hand in the panel. A round is played once published; which one
 * a date gets follows the same rotation the word lists use, so the same date
 * always plays the same round and neighbouring days are never neighbours in
 * the list. A date with no round left falls back to a theme from the bank.
 */

import { foldForPlay, letters, normalizeAnswer } from './arabic.js';
import { parseDay } from './daily.js';
import { random, shuffled } from './wordsearch.js';

/** How many words a round holds: enough for a full board, few enough to write. */
export const MIN_ROUND_WORDS = 4;
export const MAX_ROUND_WORDS = 8;
/** Each word is cut into pieces, so it needs letters to cut. */
export const WORD_LETTERS = Object.freeze([4, 10]);
export const MAX_TITLE = 40;
/** What the picture is of, for finding it again among hundreds. */
export const MAX_CATEGORY = 30;

/** A word as it is typed: Arabic letters only — the pieces are cut from them. */
const ARABIC_WORD = /^[ء-غف-ي]+$/u;

const clean = (raw) => normalizeAnswer(String(raw ?? '')).replace(/\s+/g, ' ').trim();

/** One word per line, cleaned; blank lines and comments dropped. */
export const readWordLines = (text) => String(text ?? '').split(/\r?\n/)
  .map(clean)
  .filter((line) => line && !line.startsWith('#'));

/**
 * Checks a round as the panel would save it: `{ round }` or `{ errors }`.
 * Every word is cut into pieces of two letters, so a word shorter than four
 * letters makes a board nobody can read.
 */
export function readRound({ title, category, words, imageFile, zoom, focusX, focusY }) {
  const errors = [];
  const name = clean(title);
  const group = clean(category);
  if ([...group].length > MAX_CATEGORY) errors.push(`التصنيف حتى ${MAX_CATEGORY} حرفاً.`);
  if (!name) errors.push('اكتب اسم الصورة.');
  else if ([...name].length > MAX_TITLE) errors.push(`اسم الصورة حتى ${MAX_TITLE} حرفاً.`);

  const belongs = readWordLines(words);
  if (belongs.length < MIN_ROUND_WORDS || belongs.length > MAX_ROUND_WORDS) {
    errors.push(`اكتب من ${MIN_ROUND_WORDS} إلى ${MAX_ROUND_WORDS} كلمات تخصّ الصورة، واحدة في كل سطر.`);
  }

  const seen = new Set();
  for (const word of belongs) {
    const count = letters(foldForPlay(word)).length;
    if (!ARABIC_WORD.test(word)) errors.push(`«${word}» يجب أن تكون حروفاً عربية، بلا مسافات.`);
    else if (count < WORD_LETTERS[0] || count > WORD_LETTERS[1]) {
      errors.push(`«${word}» من ${WORD_LETTERS[0]} إلى ${WORD_LETTERS[1]} حروف.`);
    }
    const key = foldForPlay(word);
    if (seen.has(key)) errors.push(`«${word}» مكتوبة مرتين.`);
    seen.add(key);
  }
  if (errors.length) return { errors };

  return {
    round: {
      title: name,
      category: group,
      words: belongs,
      imageFile: imageFile ?? null,
      zoom: Number.isFinite(Number(zoom)) ? Math.min(Math.max(Number(zoom), 1), 4) : 1,
      focusX: Number.isFinite(Number(focusX)) ? Math.min(Math.max(Number(focusX), 0), 1) : 0.5,
      focusY: Number.isFinite(Number(focusY)) ? Math.min(Math.max(Number(focusY), 0), 1) : 0.5,
    },
  };
}

/** A fixed shuffle, so neighbouring rounds in the list are not neighbouring days. */
const rotation = (list, day, salt) => (list.length ? shuffled(list, random(salt))[day % list.length] : null);

/** The picture's own body, for the game builder to cut into pieces. */
export function pictureOf(round, { publicUrl = '' } = {}) {
  if (!round?.imageFile) return null;
  return { url: `${publicUrl}/media/questions/${round.imageFile}`, zoom: round.zoom, focusX: round.focusX, focusY: round.focusY };
}

export function createBubblePictures(db, { publicUrl = '' } = {}) {
  const row = (r) => (r ? {
    id: r.id,
    title: r.title,
    category: r.category ?? '',
    imageFile: r.image_file,
    zoom: r.zoom,
    focusX: r.focus_x,
    focusY: r.focus_y,
    words: JSON.parse(r.words),
    published: Boolean(r.published),
    updatedAt: r.updated_at,
  } : null);

  const all = () => db.prepare('SELECT * FROM picture_rounds ORDER BY id DESC').all().map(row);
  const get = (id) => row(db.prepare('SELECT * FROM picture_rounds WHERE id = ?').get(Number(id)));
  const published = () => db.prepare('SELECT * FROM picture_rounds WHERE published = 1 ORDER BY id').all().map(row);

  /** Saves a checked round; `id` updates one, otherwise a new round is added. */
  function save(input, id = null) {
    const { round, errors } = readRound(input);
    if (errors) return { errors };
    const values = [round.title, round.category, round.imageFile, round.zoom, round.focusX, round.focusY,
      JSON.stringify(round.words)];
    if (id) {
      const changes = db.prepare(`UPDATE picture_rounds
        SET title = ?, category = ?, image_file = ?, zoom = ?, focus_x = ?, focus_y = ?, words = ?,
            updated_at = datetime('now')
        WHERE id = ?`).run(...values, Number(id)).changes;
      return changes ? { id: Number(id) } : { errors: ['لا توجد صورة بهذا الرقم.'] };
    }
    const result = db.prepare(`INSERT INTO picture_rounds (title, category, image_file, zoom, focus_x, focus_y, words)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(...values);
    return { id: Number(result.lastInsertRowid) };
  }

  const remove = (id) => db.prepare('DELETE FROM picture_rounds WHERE id = ?').run(Number(id)).changes > 0;

  /** A round with no picture is never played: the game is the picture. */
  function setPublished(id, on) {
    const round = get(id);
    if (!round) return { error: 'لا توجد صورة بهذا الرقم.' };
    if (on && !round.imageFile) return { error: 'أضف صورة قبل النشر.' };
    db.prepare("UPDATE picture_rounds SET published = ?, updated_at = datetime('now') WHERE id = ?").run(on ? 1 : 0, Number(id));
    return {};
  }

  /** The round a date plays, or null when nothing is published yet. */
  function forDate(date, nonce = 0) {
    const parsed = parseDay(date);
    if (!parsed) return null;
    const step = Number.isFinite(Number(nonce)) ? Math.trunc(Number(nonce)) : 0;
    const round = rotation(published(), parsed.day + step, 0xb1c7);
    return round ? { ...round, image: pictureOf(round, { publicUrl }) } : null;
  }

  const counts = () => {
    const row = db.prepare('SELECT COUNT(*) AS total, SUM(published) AS live FROM picture_rounds').get();
    return { total: row.total ?? 0, published: row.live ?? 0 };
  };

  /** The categories in use, and how many pictures each one holds. */
  const categories = () => db.prepare(`SELECT IFNULL(NULLIF(trim(category), ''), '') AS name,
      COUNT(*) AS total, SUM(published) AS live
    FROM picture_rounds GROUP BY name ORDER BY name = '' , name`).all()
    .map((row) => ({ name: row.name, total: row.total, published: row.live ?? 0 }));

  return { all, get, published, save, remove, setPublished, forDate, counts, categories };
}
