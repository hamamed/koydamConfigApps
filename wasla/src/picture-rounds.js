/**
 * صِل بالصورة: one picture, ten words, five of which belong to it.
 *
 * The other daily games are built from the question bank; this one cannot be.
 * "What belongs to a PlayStation" — ذراع التحكم، أسلاك، أقراص — is knowledge no
 * answer-and-clue pair holds, so every round is written by hand in the panel:
 * a picture, the five words that belong, and five that do not.
 *
 * A round is played once it is published. Which one a date gets follows the
 * same rotation the word lists use, so the same date always plays the same
 * round and neighbouring days are never neighbours in the list.
 */

import { foldForPlay, normalizeAnswer } from './arabic.js';
import { parseDay } from './daily.js';
import { random, shuffled } from './wordsearch.js';

export const PICTURE_WORDS = 5;
export const PICTURE_DECOYS = 5;
/** Wrong taps before the round is lost — as صِل المجموعات had. */
export const PICTURE_MISTAKES = 4;
export const MAX_TITLE = 40;
export const MAX_WORD = 24;

/** A word as it is typed: Arabic letters and spaces, nothing else. */
const ARABIC_TEXT = /^[ء-غف-ي\s]+$/u;

const clean = (raw) => normalizeAnswer(String(raw ?? '')).replace(/\s+/g, ' ').trim();

/** One word per line, cleaned; blank lines and comments dropped. */
export const readWordLines = (text) => String(text ?? '').split(/\r?\n/)
  .map(clean)
  .filter((line) => line && !line.startsWith('#'));

/**
 * Checks a round as the panel would save it: `{ round }` or `{ errors }`.
 * Both lists are exact — five that belong and five that do not — because the
 * screen shows ten words and asks for five.
 */
export function readRound({ title, words, decoys, imageFile, zoom, focusX, focusY }) {
  const errors = [];
  const name = clean(title);
  if (!name) errors.push('اكتب اسم الصورة.');
  else if ([...name].length > MAX_TITLE) errors.push(`اسم الصورة حتى ${MAX_TITLE} حرفاً.`);

  const belongs = readWordLines(words);
  const others = readWordLines(decoys);
  if (belongs.length !== PICTURE_WORDS) errors.push(`اكتب ${PICTURE_WORDS} كلمات تخصّ الصورة، واحدة في كل سطر.`);
  if (others.length !== PICTURE_DECOYS) errors.push(`اكتب ${PICTURE_DECOYS} كلمات لا تخصّها، واحدة في كل سطر.`);

  const seen = new Set();
  for (const word of [...belongs, ...others]) {
    if (!ARABIC_TEXT.test(word)) errors.push(`«${word}» يجب أن تكون حروفاً عربية.`);
    else if ([...word].length > MAX_WORD) errors.push(`«${word}» أطول من ${MAX_WORD} حرفاً.`);
    const key = foldForPlay(word);
    if (seen.has(key)) errors.push(`«${word}» مكتوبة مرتين.`);
    seen.add(key);
  }
  if (errors.length) return { errors };

  return {
    round: {
      title: name,
      words: belongs,
      decoys: others,
      imageFile: imageFile ?? null,
      zoom: Number.isFinite(Number(zoom)) ? Math.min(Math.max(Number(zoom), 1), 4) : 1,
      focusX: Number.isFinite(Number(focusX)) ? Math.min(Math.max(Number(focusX), 0), 1) : 0.5,
      focusY: Number.isFinite(Number(focusY)) ? Math.min(Math.max(Number(focusY), 0), 1) : 0.5,
    },
  };
}

/** A fixed shuffle, so neighbouring rounds in the list are not neighbouring days. */
const rotation = (list, day, salt) => (list.length ? shuffled(list, random(salt))[day % list.length] : null);

/** The game body: the picture, ten words in one shuffled row, and the five that count. */
export function buildPicture(round, seed, { publicUrl = '' } = {}) {
  if (!round) return null;
  const rand = random(seed);
  return {
    id: round.id,
    title: round.title,
    image: round.imageFile
      ? { url: `${publicUrl}/media/questions/${round.imageFile}`, zoom: round.zoom, focusX: round.focusX, focusY: round.focusY }
      : null,
    words: shuffled([...round.words, ...round.decoys], rand),
    answers: [...round.words],
    mistakes: PICTURE_MISTAKES,
  };
}

export function createPictureRounds(db, { publicUrl = '' } = {}) {
  const row = (r) => (r ? {
    id: r.id,
    title: r.title,
    imageFile: r.image_file,
    zoom: r.zoom,
    focusX: r.focus_x,
    focusY: r.focus_y,
    words: JSON.parse(r.words),
    decoys: JSON.parse(r.decoys),
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
    const values = [round.title, round.imageFile, round.zoom, round.focusX, round.focusY,
      JSON.stringify(round.words), JSON.stringify(round.decoys)];
    if (id) {
      const changes = db.prepare(`UPDATE picture_rounds
        SET title = ?, image_file = ?, zoom = ?, focus_x = ?, focus_y = ?, words = ?, decoys = ?, updated_at = datetime('now')
        WHERE id = ?`).run(...values, Number(id)).changes;
      return changes ? { id: Number(id) } : { errors: ['لا توجد صورة بهذا الرقم.'] };
    }
    const result = db.prepare(`INSERT INTO picture_rounds (title, image_file, zoom, focus_x, focus_y, words, decoys)
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

  /** What a date plays, or null when nothing is published yet. */
  function forDate(date, nonce = 0) {
    const parsed = parseDay(date);
    if (!parsed) return null;
    const list = published();
    const step = Number.isFinite(Number(nonce)) ? Math.trunc(Number(nonce)) : 0;
    const round = rotation(list, parsed.day + step, 0xb1c7);
    const seed = (Math.imul(parsed.day + 1, 2654435761) ^ Math.imul(step + 3, 40503)) >>> 0;
    return buildPicture(round, seed, { publicUrl });
  }

  const counts = () => {
    const row = db.prepare('SELECT COUNT(*) AS total, SUM(published) AS live FROM picture_rounds').get();
    return { total: row.total ?? 0, published: row.live ?? 0 };
  };

  return { all, get, published, save, remove, setPublished, forDate, counts };
}
