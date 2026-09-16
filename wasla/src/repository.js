/**
 * Questions and levels, and the rules between them.
 *
 * Every write that changes a level's words lays its grid out again, so what the
 * panel previews is always exactly what the app receives.
 */

import { answerProblem, foldForPlay, normalizeAnswer } from './arabic.js';
import { generateLayout } from './layout.js';
import { createPackStore, GENERAL_PACK } from './packs.js';
import { deriveType, emojiProblem, normalizeEmoji, QUESTION_TYPES, TYPE_NEEDS } from './question-types.js';

export const MAX_CLUE = 200;
export const MAX_ZOOM = 5;
export const MIN_WORDS = 2;
export const DIFFICULTIES = ['easy', 'medium', 'hard'];

const toQuestion = (row) => row && ({
  id: row.id,
  answer: row.answer,
  // Stored answers are never rewritten: the played form is worked out on read,
  // so questions written before folding existed are laid out folded too.
  playAnswer: foldForPlay(row.answer),
  clue: row.clue,
  category: row.category || '',
  type: row.type || 'text',
  emoji: row.emoji || null,
  imageFile: row.image_file || null,
  zoom: row.image_zoom,
  focusX: row.focus_x,
  focusY: row.focus_y,
  blurred: Boolean(row.image_blurred),
  audioFile: row.audio_file || null,
  updatedAt: iso(row.updated_at),
  levelCount: row.level_count ?? 0,
});

/** SQLite's datetime('now') is UTC without a zone; the app wants ISO 8601. */
const iso = (value) => (value ? `${value.replace(' ', 'T')}Z` : null);

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/** A checkbox, a CSV cell or a boolean, read as one. */
export const truthy = (value) => value === true || value === 1 || ['1', 'true', 'on', 'yes'].includes(String(value ?? '').trim().toLowerCase());

/**
 * The question type: the one chosen, when its media is there, else derived.
 *
 * A type carried over from before an edit (not chosen in this input) falls back
 * to the derived one when its media went away — removing a picture should not
 * leave a question that cannot be saved.
 */
function readType(input, current, media) {
  const chosen = input.type !== undefined && input.type !== '' ? String(input.type) : null;
  if (chosen && !QUESTION_TYPES.includes(chosen)) return { error: `A question type is one of: ${QUESTION_TYPES.join(', ')}.` };

  const candidate = chosen ?? current.type ?? null;
  const need = candidate && TYPE_NEEDS[candidate];
  if (need && !media[need[0]]) {
    if (chosen) return { error: need[1] };
    return { type: deriveType(media) };
  }
  return { type: candidate ?? deriveType(media) };
}

/** Validated, normalised question fields, or `{ error }`. */
function readQuestion(input, current = {}) {
  const answer = normalizeAnswer(input.answer ?? current.answer);
  const problem = answerProblem(answer);
  if (problem) return { error: problem };

  const clue = String(input.clue ?? current.clue ?? '').trim();
  if (!clue) return { error: 'A clue is required — it is the question the player reads.' };
  if (clue.length > MAX_CLUE) return { error: `A clue can be at most ${MAX_CLUE} characters.` };

  const zoom = Number(input.zoom ?? current.zoom ?? 1);
  if (!Number.isFinite(zoom) || zoom < 1 || zoom > MAX_ZOOM) {
    return { error: `Image zoom must be between 1 and ${MAX_ZOOM}.` };
  }

  const focusX = Number(input.focusX ?? current.focusX ?? 0.5);
  const focusY = Number(input.focusY ?? current.focusY ?? 0.5);
  if (!Number.isFinite(focusX) || !Number.isFinite(focusY)) return { error: 'The image focus point is not valid.' };

  const emoji = normalizeEmoji(input.emoji !== undefined ? input.emoji : current.emoji);
  if (emoji) {
    const emojiError = emojiProblem(emoji);
    if (emojiError) return { error: emojiError };
  }

  const media = {
    imageFile: input.imageFile !== undefined ? input.imageFile : (current.imageFile ?? null),
    audioFile: input.audioFile !== undefined ? input.audioFile : (current.audioFile ?? null),
    emoji: emoji || null,
  };
  const { type, error } = readType(input, current, media);
  if (error) return { error };

  const blurred = input.blurred !== undefined ? truthy(input.blurred) : Boolean(current.blurred);

  return {
    fields: {
      answer,
      clue,
      category: String(input.category ?? current.category ?? '').trim().slice(0, 60) || null,
      type,
      emoji: media.emoji,
      image_file: media.imageFile,
      image_zoom: Math.round(zoom * 100) / 100,
      focus_x: clamp01(focusX),
      focus_y: clamp01(focusY),
      // Blurring means nothing without a picture to blur.
      image_blurred: blurred && media.imageFile ? 1 : 0,
      audio_file: media.audioFile,
    },
  };
}

export function createRepository(db) {
  const tx = (fn) => db.transaction(fn)();
  const packs = createPackStore(db);

  // ── Questions ──────────────────────────────────────────────────────────────

  const QUESTION_SELECT = `
    SELECT q.*, (SELECT COUNT(*) FROM level_words lw WHERE lw.question_id = q.id) AS level_count
    FROM questions q`;

  function listQuestions({ search = '', unused = false } = {}) {
    const term = `%${String(search).trim()}%`;
    return db.prepare(`${QUESTION_SELECT}
      WHERE (q.answer LIKE @term OR q.clue LIKE @term OR IFNULL(q.category, '') LIKE @term)
      ${unused ? 'AND NOT EXISTS (SELECT 1 FROM level_words lw WHERE lw.question_id = q.id)' : ''}
      ORDER BY q.id DESC`).all({ term }).map(toQuestion);
  }

  function getQuestion(id) {
    return toQuestion(db.prepare(`${QUESTION_SELECT} WHERE q.id = ?`).get(id));
  }

  function levelsUsing(questionId) {
    return db.prepare(`SELECT l.id, l.title, l.published FROM levels l
      JOIN level_words lw ON lw.level_id = l.id WHERE lw.question_id = ? ORDER BY l.position`).all(questionId);
  }

  /** The same checks a save makes, without saving: `{ error }` or `{ question }` as it would be stored. */
  function checkQuestion(input) {
    const { fields, error } = readQuestion(input);
    if (error) return { error };
    return { question: { answer: fields.answer, playAnswer: foldForPlay(fields.answer), type: fields.type } };
  }

  function createQuestion(input) {
    const { fields, error } = readQuestion(input);
    if (error) return { error };
    const { lastInsertRowid } = db.prepare(`INSERT INTO questions
      (answer, clue, category, type, emoji, image_file, image_zoom, focus_x, focus_y, image_blurred, audio_file)
      VALUES (@answer, @clue, @category, @type, @emoji, @image_file, @image_zoom, @focus_x, @focus_y, @image_blurred, @audio_file)`).run(fields);
    return { question: getQuestion(lastInsertRowid) };
  }

  /**
   * Updates a question. When the answer changes, every level using it is laid
   * out again; a published level that no longer connects is unpublished and
   * named in `unpublished`, so the panel can say so.
   */
  function updateQuestion(id, input) {
    const current = getQuestion(id);
    if (!current) return { error: 'That question no longer exists.' };
    const { fields, error } = readQuestion(input, current);
    if (error) return { error };

    return tx(() => {
      db.prepare(`UPDATE questions SET answer = @answer, clue = @clue, category = @category,
        type = @type, emoji = @emoji, image_file = @image_file, image_zoom = @image_zoom,
        focus_x = @focus_x, focus_y = @focus_y, image_blurred = @image_blurred, audio_file = @audio_file,
        updated_at = datetime('now') WHERE id = @id`).run({ ...fields, id });

      const unpublished = [];
      if (foldForPlay(fields.answer) !== current.playAnswer) {
        for (const level of levelsUsing(id)) {
          const { unplaced } = relayout(level.id);
          if (level.published && unplaced.length) {
            setPublishedRow(level.id, false);
            unpublished.push(level.title);
          }
        }
      }
      touchLevelsUsing(id);
      return { question: getQuestion(id), previousImage: current.imageFile, previousAudio: current.audioFile, unpublished };
    });
  }

  function deleteQuestion(id) {
    const using = levelsUsing(id);
    if (using.length) {
      return { error: `Remove it from these levels first: ${using.map((l) => l.title).join('، ')}.` };
    }
    const current = getQuestion(id);
    db.prepare('DELETE FROM questions WHERE id = ?').run(id);
    return { imageFile: current?.imageFile ?? null, audioFile: current?.audioFile ?? null };
  }

  function touchLevelsUsing(questionId) {
    db.prepare(`UPDATE levels SET updated_at = datetime('now')
      WHERE id IN (SELECT level_id FROM level_words WHERE question_id = ?)`).run(questionId);
  }

  /** Whether a generated media name is still used by any question. */
  function mediaInUse(file) {
    return Boolean(db.prepare('SELECT 1 FROM questions WHERE image_file = ? OR audio_file = ?').get(file, file));
  }

  // ── Levels ─────────────────────────────────────────────────────────────────

  function wordsOf(levelId) {
    return db.prepare(`SELECT lw.grid_row, lw.grid_col, lw.direction, q.*
      FROM level_words lw JOIN questions q ON q.id = lw.question_id
      WHERE lw.level_id = ? ORDER BY q.id`).all(levelId).map((row) => ({
      ...toQuestion(row),
      row: row.grid_row,
      col: row.grid_col,
      direction: row.direction,
    }));
  }

  const toLevel = (row) => row && ({
    id: row.id,
    title: row.title,
    position: row.position,
    published: Boolean(row.published),
    seed: row.seed,
    rows: row.grid_rows,
    cols: row.grid_cols,
    updatedAt: iso(row.updated_at),
    wordCount: row.word_count ?? 0,
    unplacedCount: row.unplaced_count ?? 0,
    packId: row.pack_id ?? null,
    packSlug: row.pack_slug ?? GENERAL_PACK.slug,
    packTitle: row.pack_title ?? GENERAL_PACK.title,
    packColor: row.pack_color ?? GENERAL_PACK.color,
    difficulty: DIFFICULTIES.includes(row.difficulty) ? row.difficulty : 'medium',
  });

  const LEVEL_SELECT = `SELECT l.*, p.slug AS pack_slug, p.title AS pack_title, p.color AS pack_color,
      (SELECT COUNT(*) FROM level_words lw WHERE lw.level_id = l.id) AS word_count,
      (SELECT COUNT(*) FROM level_words lw WHERE lw.level_id = l.id AND lw.direction IS NULL) AS unplaced_count
    FROM levels l LEFT JOIN packs p ON p.id = l.pack_id`;

  function listLevels() {
    return db.prepare(`${LEVEL_SELECT} ORDER BY l.position, l.id`).all().map(toLevel);
  }

  function getLevel(id) {
    const level = toLevel(db.prepare(`${LEVEL_SELECT} WHERE l.id = ?`).get(id));
    if (!level) return null;
    const words = wordsOf(id);
    return { ...level, words: words.filter((w) => w.direction), unplaced: words.filter((w) => !w.direction) };
  }

  function findLevelByTitle(title) {
    const row = db.prepare('SELECT id FROM levels WHERE title = ? ORDER BY position, id LIMIT 1').get(String(title ?? '').trim());
    return row ? getLevel(row.id) : null;
  }

  /** A validated pack id (null for general) and difficulty, or `{ error }`. */
  function readLevelDetails({ packId, difficulty } = {}) {
    const id = packId === undefined || packId === null || packId === '' || Number(packId) === 0 ? null : Number(packId);
    if (id !== null && !packs.getPack(id)) return { error: 'That pack no longer exists.' };
    const level = difficulty ?? 'medium';
    if (!DIFFICULTIES.includes(level)) return { error: `The difficulty is one of: ${DIFFICULTIES.join(', ')}.` };
    return { packId: id, difficulty: level };
  }

  function createLevel(title, details = {}) {
    const { packId, difficulty, error } = readLevelDetails(details);
    // Callers check details first; reaching here with bad ones is a bug, not input.
    if (error) throw new Error(error);
    const clean = String(title ?? '').trim().slice(0, 80) || 'مستوى جديد';
    const { next } = db.prepare('SELECT IFNULL(MAX(position), 0) + 1 AS next FROM levels').get();
    const { lastInsertRowid } = db.prepare('INSERT INTO levels (title, position, pack_id, difficulty) VALUES (?, ?, ?, ?)')
      .run(clean, next, packId, difficulty);
    return getLevel(lastInsertRowid);
  }

  function renameLevel(id, title) {
    const clean = String(title ?? '').trim().slice(0, 80);
    if (!clean) return { error: 'A level needs a title.' };
    db.prepare("UPDATE levels SET title = ?, updated_at = datetime('now') WHERE id = ?").run(clean, id);
    return { level: getLevel(id) };
  }

  function setLevelDetails(id, details) {
    const { packId, difficulty, error } = readLevelDetails(details);
    if (error) return { error };
    db.prepare("UPDATE levels SET pack_id = ?, difficulty = ?, updated_at = datetime('now') WHERE id = ?")
      .run(packId, difficulty, id);
    return { level: getLevel(id) };
  }

  /** Lays a level's current words out again with its seed, and stores the result. */
  function relayout(levelId) {
    const { seed } = db.prepare('SELECT seed FROM levels WHERE id = ?').get(levelId);
    const words = db.prepare(`SELECT q.id, q.answer FROM level_words lw
      JOIN questions q ON q.id = lw.question_id WHERE lw.level_id = ? ORDER BY q.id`).all(levelId)
      // Crossings are checked on the played letters: أسد and امل share an ا.
      .map((w) => ({ id: w.id, answer: foldForPlay(w.answer) }));
    const layout = generateLayout(words, { seed });

    const place = db.prepare(`UPDATE level_words SET grid_row = ?, grid_col = ?, direction = ?
      WHERE level_id = ? AND question_id = ?`);
    db.prepare('UPDATE level_words SET grid_row = NULL, grid_col = NULL, direction = NULL WHERE level_id = ?').run(levelId);
    for (const p of layout.placements) place.run(p.row, p.col, p.direction, levelId, p.id);
    db.prepare("UPDATE levels SET grid_rows = ?, grid_cols = ?, updated_at = datetime('now') WHERE id = ?")
      .run(layout.rows, layout.cols, levelId);
    return layout;
  }

  function setLevelQuestions(id, questionIds) {
    const ids = [...new Set(questionIds.map(Number).filter(Number.isInteger))];
    return tx(() => {
      db.prepare('DELETE FROM level_words WHERE level_id = ?').run(id);
      const add = db.prepare('INSERT INTO level_words (level_id, question_id) SELECT ?, id FROM questions WHERE id = ?');
      for (const qid of ids) add.run(id, qid);
      const layout = relayout(id);
      let unpublished = false;
      const level = getLevel(id);
      if (level.published && publishProblem(level)) {
        setPublishedRow(id, false);
        unpublished = true;
      }
      return { layout, unpublished };
    });
  }

  /** A different arrangement of the same words. */
  function shuffleLevel(id) {
    return tx(() => {
      db.prepare('UPDATE levels SET seed = seed + 1 WHERE id = ?').run(id);
      return relayout(id);
    });
  }

  function publishProblem(level) {
    if (level.words.length + level.unplaced.length < MIN_WORDS) return `A level needs at least ${MIN_WORDS} words.`;
    if (level.unplaced.length) {
      return `Some words do not cross the others: ${level.unplaced.map((w) => w.answer).join('، ')}. Remove them or add words that share their letters.`;
    }
    return null;
  }

  function setPublishedRow(id, on) {
    db.prepare("UPDATE levels SET published = ?, updated_at = datetime('now') WHERE id = ?").run(on ? 1 : 0, id);
  }

  function setPublished(id, on) {
    const level = getLevel(id);
    if (!level) return { error: 'That level no longer exists.' };
    if (on) {
      const problem = publishProblem(level);
      if (problem) return { error: problem };
    }
    setPublishedRow(id, on);
    return {};
  }

  function deleteLevel(id) {
    db.prepare('DELETE FROM levels WHERE id = ?').run(id);
  }

  /** Rewrites every position densely from an ordered list of ids. */
  function writeOrder(order) {
    const set = db.prepare('UPDATE levels SET position = ? WHERE id = ?');
    order.forEach((levelId, k) => set.run(k + 1, levelId));
  }

  /** Swaps a level with its neighbour. */
  function moveLevel(id, direction) {
    const levels = listLevels();
    const i = levels.findIndex((l) => l.id === Number(id));
    const j = direction === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= levels.length) return;
    tx(() => {
      // Positions are rewritten densely, so gaps or ties from old data cannot stall a move.
      const order = levels.map((l) => l.id);
      [order[i], order[j]] = [order[j], order[i]];
      writeOrder(order);
    });
  }

  /**
   * Sorts the levels of each pack: easy first, then fewer words, then the order
   * they were already in. Each pack keeps the slots it held in the overall
   * order, so packs stay interleaved the way the admin arranged them.
   *
   * Returns how many levels changed place.
   */
  function orderByDifficulty() {
    const levels = listLevels();
    const slots = new Map();
    levels.forEach((level, index) => {
      const key = level.packId ?? 0;
      slots.set(key, [...(slots.get(key) ?? []), { level, index }]);
    });

    const order = levels.map((l) => l.id);
    const rank = (d) => DIFFICULTIES.indexOf(d);
    for (const entries of slots.values()) {
      const sorted = [...entries].sort((a, b) =>
        rank(a.level.difficulty) - rank(b.level.difficulty)
        || a.level.wordCount - b.level.wordCount
        || a.index - b.index);
      entries.forEach(({ index }, k) => { order[index] = sorted[k].level.id; });
    }

    const moved = order.filter((levelId, k) => levelId !== levels[k].id).length;
    tx(() => writeOrder(order));
    return moved;
  }

  // ── What the app sees ─────────────────────────────────────────────────────

  /** Published levels in app order, each with its public summary. */
  function publishedEntries() {
    const rows = db.prepare(`${LEVEL_SELECT} WHERE l.published = 1 ORDER BY l.position, l.id`).all().map(toLevel);
    const inPack = new Map();
    return rows.map((level, i) => {
      const packPosition = (inPack.get(level.packSlug) ?? 0) + 1;
      inPack.set(level.packSlug, packPosition);
      return {
        id: level.id,
        summary: {
          number: i + 1,
          title: level.title,
          wordCount: level.wordCount,
          rows: level.rows,
          cols: level.cols,
          updatedAt: level.updatedAt,
          pack: level.packSlug,
          difficulty: level.difficulty,
          packPosition,
        },
      };
    });
  }

  /** Summaries in app order; with `pack`, only that pack's, by position inside it. */
  function publishedLevels({ pack } = {}) {
    const summaries = publishedEntries().map((e) => e.summary);
    if (pack === undefined) return summaries;
    return summaries
      .filter((s) => s.pack === pack)
      .sort((a, b) => a.packPosition - b.packPosition || a.number - b.number);
  }

  /** Level ids in public number order: index 0 is level 1. */
  function publishedLevelIds() {
    return publishedEntries().map((e) => e.id);
  }

  function publishedLevel(number) {
    const entry = publishedEntries()[Number(number) - 1];
    if (!entry) return null;
    return { ...entry.summary, words: getLevel(entry.id).words };
  }

  function publishedLevelById(id) {
    const entry = publishedEntries().find((e) => e.id === Number(id));
    if (!entry) return null;
    return { ...entry.summary, words: getLevel(entry.id).words };
  }

  function counts() {
    return db.prepare(`SELECT
      (SELECT COUNT(*) FROM questions) AS questions,
      (SELECT COUNT(*) FROM questions WHERE image_file IS NOT NULL) AS withImages,
      (SELECT COUNT(*) FROM questions q WHERE NOT EXISTS (SELECT 1 FROM level_words lw WHERE lw.question_id = q.id)) AS unused,
      (SELECT COUNT(*) FROM levels) AS levels,
      (SELECT COUNT(*) FROM levels WHERE published = 1) AS published`).get();
  }

  return {
    ...packs,
    /** Runs `fn` in one transaction; nested calls become savepoints. */
    transaction: (fn) => tx(fn),
    listQuestions, getQuestion, checkQuestion, createQuestion, updateQuestion, deleteQuestion, levelsUsing, mediaInUse,
    listLevels, getLevel, findLevelByTitle, createLevel, renameLevel, setLevelDetails, setLevelQuestions, shuffleLevel,
    setPublished, deleteLevel, moveLevel, orderByDifficulty,
    publishedLevels, publishedLevelIds, publishedLevel, publishedLevelById, counts,
  };
}
