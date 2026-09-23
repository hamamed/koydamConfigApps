import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { sniffAudio } from './audio.js';

const run = promisify(execFile);

/**
 * The sound library: every clip the panel holds, and the cut that made it.
 *
 * A clip is an uploaded sound trimmed to a piece of itself — «من 00:35 لمدة 8
 * ثوان» — re-encoded to MP3 so the app plays one format. The cut is done by
 * ffmpeg; without ffmpeg the upload is refused rather than stored whole, so a
 * library of full tracks never builds up by accident.
 *
 * A clip also carries a `category`, from the same list questions take their
 * فئة from: it is what lets a library of hundreds be found, and a question
 * made from a clip starts in that category.
 *
 * Nothing here fetches a sound from anywhere. A clip is made from a file the
 * panel is given, and `source`, `licence` and `author` say where it came from
 * and on what terms.
 *
 * `cleared` is the gate between having a clip and publishing it. A clip whose
 * terms already allow it — CC BY, CC0, your own recording — is cleared as it
 * is stored; anything else stays at 0 until permission is recorded against it
 * in `cleared_note`. The API serves no sound for a question whose clip is not
 * cleared, so a clip kept to audition can never reach the app by accident.
 */

export const MAX_SECONDS = 30;
export const MIN_SECONDS = 1;
export const MAX_TITLE = 120;
export const MAX_CATEGORY = 30;
/** What the panel offers; anything else may be typed. */
export const LICENCES = Object.freeze(['CC0', 'CC BY 4.0', 'CC BY-SA 4.0', 'Public Domain', 'مِلكنا']);
/** Licences that publish a clip the moment it is stored; everything else waits. */
const CLEARS = [/^cc0/i, /^cc[ -]by/i, /^public domain/i, /^مِلكنا$/, /^ملكنا$/];

/** Whether a licence, as typed, already permits publishing. */
export const licenceClears = (licence) => CLEARS.some((r) => r.test(String(licence ?? '').trim()));

/** "1:05" or "65" or "1:05.5" → seconds, or null. */
export function readTime(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return 0;
  if (!/^(\d+:)?\d+(\.\d+)?$/.test(text)) return null;
  const [a, b] = text.split(':');
  const seconds = b === undefined ? Number(a) : Number(a) * 60 + Number(b);
  return Number.isFinite(seconds) && seconds >= 0 && seconds < 86_400 ? seconds : null;
}

/** Seconds as the panel prints them: 0:08, 1:05. */
export const clockText = (seconds) => {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** How long a sound is, in seconds, or null when ffprobe cannot say. */
async function lengthOf(file) {
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
    ]);
    const seconds = Number(String(stdout).trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch {
    return null;
  }
}

export function createAudioClips(db, { audio, tools = { run, lengthOf } }) {
  const insert = db.prepare(`INSERT INTO audio_clips (file, title, category, source, licence, author, seconds, cleared, cleared_note)
    VALUES (@file, @title, @category, @source, @licence, @author, @seconds, @cleared, @cleared_note)`);

  const readCategory = (raw) => {
    const clean = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CATEGORY);
    return clean || null;
  };

  /**
   * Clips, newest first, with how many questions use each.
   * `category` narrows it; the empty string is the clips with none.
   */
  function list({ category = null } = {}) {
    const where = category === null ? ''
      : category === '' ? "WHERE IFNULL(trim(c.category), '') = ''"
        : 'WHERE trim(c.category) = @category';
    return db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM questions q WHERE q.audio_file = c.file) AS used
      FROM audio_clips c ${where} ORDER BY c.created_at DESC, c.id DESC`).all({ category: String(category ?? '') });
  }

  /** The categories in use, and how many clips each holds — the uncategorised last. */
  const categories = () => db.prepare(`SELECT IFNULL(NULLIF(trim(category), ''), '') AS name, COUNT(*) AS total
    FROM audio_clips GROUP BY name ORDER BY (name = '') ASC, name ASC`).all();

  const get = (id) => db.prepare('SELECT * FROM audio_clips WHERE id = ?').get(Number(id)) ?? null;

  /**
   * Cuts `buffer` from `start` for `seconds` and keeps the piece.
   * `{ clip }`, or `{ error }` — and nothing is stored when anything is wrong.
   */
  async function save(buffer, {
    title, category = '', start = 0, seconds, source = '', licence = '', author = '',
    cleared = null, clearedNote = '',
  }) {
    const name = String(title ?? '').trim().slice(0, MAX_TITLE);
    if (!name) return { error: 'اكتب اسماً للمقطع.' };
    if (!sniffAudio(buffer)) return { error: 'الملف ليس MP3 أو M4A أو AAC أو WAV.' };
    const from = readTime(start);
    if (from === null) return { error: 'بداية القص غير صحيحة؛ اكتبها ثوانٍ أو د:ث.' };
    const length = readTime(seconds);
    if (length === null || length < MIN_SECONDS || length > MAX_SECONDS) {
      return { error: `مدة المقطع من ${MIN_SECONDS} إلى ${MAX_SECONDS} ثانية.` };
    }

    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'wasla-clip-'));
    const input = path.join(work, 'in');
    const output = path.join(work, 'out.mp3');
    try {
      await fs.writeFile(input, buffer);
      const whole = await tools.lengthOf(input);
      if (whole !== null && from >= whole) {
        return { error: `بداية القص (${clockText(from)}) بعد نهاية الملف (${clockText(whole)}).` };
      }
      try {
        // -ss before -i seeks without decoding what comes before it.
        await tools.run('ffmpeg', ['-v', 'error', '-y', '-ss', String(from), '-t', String(length),
          '-i', input, '-vn', '-ac', '1', '-ar', '44100', '-b:a', '128k', output]);
      } catch {
        return { error: 'تعذّر قص الملف. تأكد من تثبيت ffmpeg على الخادم.' };
      }
      const cut = await fs.readFile(output);
      const cutSeconds = (await tools.lengthOf(output)) ?? length;
      if (!cut.length) return { error: 'المقطع خرج فارغاً؛ جرّب بداية أبكر.' };

      const stored = await audio.save(cut);
      if (stored.error) return { error: stored.error };
      const id = insert.run({
        file: stored.file,
        title: name,
        category: readCategory(category),
        source: String(source ?? '').trim().slice(0, 500) || null,
        licence: String(licence ?? '').trim().slice(0, 80) || null,
        author: String(author ?? '').trim().slice(0, 120) || null,
        seconds: Math.round(cutSeconds),
        // Told explicitly, or read from the licence that was typed.
        cleared: (cleared === null ? licenceClears(licence) : Boolean(cleared)) ? 1 : 0,
        cleared_note: String(clearedNote ?? '').trim().slice(0, 300) || null,
      }).lastInsertRowid;
      return { clip: get(id) };
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  }

  /** Renames a clip, moves it to another category, or re-credits it. */
  function update(id, { title, category, source, licence, author }) {
    const clip = get(id);
    if (!clip) return { error: 'لا مقطع بهذا الرقم.' };
    const name = String(title ?? '').trim().slice(0, MAX_TITLE);
    if (!name) return { error: 'اكتب اسماً للمقطع.' };
    db.prepare('UPDATE audio_clips SET title = ?, category = ?, source = ?, licence = ?, author = ? WHERE id = ?')
      .run(name, readCategory(category), String(source ?? '').trim().slice(0, 500) || null,
        String(licence ?? '').trim().slice(0, 80) || null,
        String(author ?? '').trim().slice(0, 120) || null, clip.id);
    return { clip: get(clip.id) };
  }

  /**
   * Forgets a clip, and deletes its file when no question plays it — a clip a
   * question uses leaves the library but keeps sounding in the app.
   */
  async function remove(id, { inUse }) {
    const clip = get(id);
    if (!clip) return { error: 'لا مقطع بهذا الرقم.' };
    db.prepare('DELETE FROM audio_clips WHERE id = ?').run(clip.id);
    if (!inUse(clip.file)) await audio.remove(clip.file);
    return { removed: clip };
  }

  /**
   * Records that a clip may be published — or takes that back. `note` is where
   * the permission came from, so the answer to "who said we could?" is kept
   * beside the clip rather than in somebody's inbox.
   */
  function setCleared(id, cleared, note = '') {
    const clip = get(id);
    if (!clip) return { error: 'لا مقطع بهذا الرقم.' };
    db.prepare('UPDATE audio_clips SET cleared = ?, cleared_note = ? WHERE id = ?')
      .run(cleared ? 1 : 0, String(note ?? '').trim().slice(0, 300) || null, clip.id);
    return { clip: get(clip.id) };
  }

  /** Whether the file behind a question may be served: unknown files are older uploads, and pass. */
  function isPublishable(file) {
    const row = db.prepare('SELECT cleared FROM audio_clips WHERE file = ?').get(file);
    return !row || row.cleared === 1;
  }

  return { list, categories, get, save, update, remove, setCleared, isPublishable };
}
