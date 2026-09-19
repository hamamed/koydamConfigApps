/**
 * Questions and levels, and the rules between them.
 *
 * Every write that changes a level's words lays its grid out again, so what the
 * panel previews is always exactly what the app receives.
 */

import { answerProblem, foldForPlay, normalizeAnswer } from './arabic.js';
import { generateLayout } from './layout.js';
import { appLevelTitle, levelName } from './level-label.js';
import { deriveType, emojiProblem, normalizeEmoji, QUESTION_TYPES, TYPE_NEEDS } from './question-types.js';

export const MAX_CLUE = 200;
export const MAX_TITLE = 40;
export const MAX_CREDIT = 160;
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
  // Rows from before titles (and not backfilled) read as an empty title.
  title: row.title || '',
  type: row.type || 'text',
  emoji: row.emoji || null,
  imageFile: row.image_file || null,
  // A picture's credit: who took it, its licence, and the page it came from.
  imageAuthor: row.image_author || '',
  imageLicence: row.image_licence || '',
  imageSource: row.image_source || '',
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

  // Checked against the type below: a picture, sound or emoji can stand on its title alone.
  const clue = String(input.clue ?? current.clue ?? '').trim();
  if (clue.length > MAX_CLUE) return { error: `A clue can be at most ${MAX_CLUE} characters.` };

  const title = String(input.title ?? current.title ?? '').trim();
  if (!title) return { error: 'A title is required — it is shown above the question in the app.' };
  if ([...title].length > MAX_TITLE) return { error: `A title can be at most ${MAX_TITLE} characters.` };

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
  if (type === 'text' && !clue) {
    return { error: 'A text question needs a clue — it is all the player has to go on. Pictures, sounds and emoji may leave it empty.' };
  }

  const blurred = input.blurred !== undefined ? truthy(input.blurred) : Boolean(current.blurred);

  const credit = (key) => String(input[key] ?? current[key] ?? '').trim().slice(0, MAX_CREDIT);
  const imageAuthor = credit('imageAuthor');
  const imageLicence = credit('imageLicence');
  const imageSource = credit('imageSource');
  if (imageSource && !/^https?:\/\//i.test(imageSource)) {
    return { error: 'The picture source must be a web address starting with http:// or https://.' };
  }

  return {
    fields: {
      answer,
      clue,
      title,
      type,
      emoji: media.emoji,
      image_file: media.imageFile,
      image_zoom: Math.round(zoom * 100) / 100,
      focus_x: clamp01(focusX),
      focus_y: clamp01(focusY),
      // Blurring means nothing without a picture to blur.
      image_blurred: blurred && media.imageFile ? 1 : 0,
      audio_file: media.audioFile,
      // Kept only while there is a picture to credit.
      image_author: media.imageFile ? imageAuthor || null : null,
      image_licence: media.imageFile ? imageLicence || null : null,
      image_source: media.imageFile ? imageSource || null : null,
    },
  };
}

export function createRepository(db) {
  const tx = (fn) => db.transaction(fn)();

  // ── Questions ──────────────────────────────────────────────────────────────

  const QUESTION_SELECT = `
    SELECT q.*, (SELECT COUNT(*) FROM level_words lw WHERE lw.question_id = q.id) AS level_count
    FROM questions q`;

  /** `title` keeps only questions with exactly that title. */
  function listQuestions({ search = '', unused = false, title = '' } = {}) {
    const term = `%${String(search).trim()}%`;
    const exact = String(title ?? '').trim();
    return db.prepare(`${QUESTION_SELECT}
      WHERE (q.answer LIKE @term OR q.clue LIKE @term OR IFNULL(q.title, '') LIKE @term)
      ${exact ? 'AND trim(q.title) = @exact' : ''}
      ${unused ? 'AND NOT EXISTS (SELECT 1 FROM level_words lw WHERE lw.question_id = q.id)' : ''}
      ORDER BY q.id DESC`).all({ term, exact }).map(toQuestion);
  }

  /** Every picture that names a photographer or a licence, for the credits page. */
  function credited() {
    return db.prepare(`${QUESTION_SELECT}
      WHERE q.image_file IS NOT NULL AND (IFNULL(q.image_author, '') <> '' OR IFNULL(q.image_licence, '') <> '')
      ORDER BY q.title, q.id`).all().map(toQuestion);
  }

  function getQuestion(id) {
    return toQuestion(db.prepare(`${QUESTION_SELECT} WHERE q.id = ?`).get(id));
  }

  /** The levels a question is in, in panel order, each with its number and `name` ("Level 3"). */
  function levelsUsing(questionId) {
    const using = new Set(db.prepare('SELECT level_id FROM level_words WHERE question_id = ?').all(questionId).map((r) => r.level_id));
    return listLevels().filter((l) => using.has(l.id));
  }

  /** The same checks a save makes, without saving: `{ error }` or `{ question }` as it would be stored. */
  function checkQuestion(input) {
    const { fields, error } = readQuestion(input);
    if (error) return { error };
    return { question: { answer: fields.answer, playAnswer: foldForPlay(fields.answer), title: fields.title, type: fields.type } };
  }

  function createQuestion(input) {
    const { fields, error } = readQuestion(input);
    if (error) return { error };
    const { lastInsertRowid } = db.prepare(`INSERT INTO questions
      (answer, clue, title, type, emoji, image_file, image_zoom, focus_x, focus_y, image_blurred, audio_file,
       image_author, image_licence, image_source)
      VALUES (@answer, @clue, @title, @type, @emoji, @image_file, @image_zoom, @focus_x, @focus_y, @image_blurred, @audio_file,
              @image_author, @image_licence, @image_source)`).run(fields);
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
      db.prepare(`UPDATE questions SET answer = @answer, clue = @clue, title = @title,
        type = @type, emoji = @emoji, image_file = @image_file, image_zoom = @image_zoom,
        focus_x = @focus_x, focus_y = @focus_y, image_blurred = @image_blurred, audio_file = @audio_file,
        image_author = @image_author, image_licence = @image_licence, image_source = @image_source,
        updated_at = datetime('now') WHERE id = @id`).run({ ...fields, id });

      const unpublished = [];
      if (foldForPlay(fields.answer) !== current.playAnswer) {
        for (const level of levelsUsing(id)) {
          const { unplaced } = relayout(level.id);
          if (level.published && unplaced.length) {
            setPublishedRow(level.id, false);
            unpublished.push(level.name);
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
      return { error: `Remove it from these levels first: ${using.map((l) => l.name).join(', ')}.` };
    }
    const current = getQuestion(id);
    db.prepare('DELETE FROM questions WHERE id = ?').run(id);
    return { imageFile: current?.imageFile ?? null, audioFile: current?.audioFile ?? null };
  }

  // ── Bulk actions (the questions list) ─────────────────────────────────────

  /** Whole, positive, distinct ids from a form field that may be one value or many. */
  const cleanIds = (ids) => [...new Set((Array.isArray(ids) ? ids : [ids])
    .map(Number).filter((n) => Number.isInteger(n) && n > 0))];

  /** Lays a level out again after its words changed; unpublishes it, returning its name, if it can no longer be published. */
  function refreshLevel(levelId) {
    relayout(levelId);
    const level = getLevel(levelId);
    if (!level.published || !publishProblem(level)) return null;
    setPublishedRow(levelId, false);
    return level.name;
  }

  /** Takes questions out of whatever levels hold them. `{ removed, unpublished: [level names] }`. */
  function removeQuestionsFromLevels(ids) {
    const clean = cleanIds(ids);
    return tx(() => {
      const levelOf = db.prepare('SELECT level_id FROM level_words WHERE question_id = ?');
      const levelIds = [...new Set(clean.flatMap((id) => levelOf.all(id).map((r) => r.level_id)))];
      const drop = db.prepare('DELETE FROM level_words WHERE question_id = ?');
      const removed = clean.reduce((sum, id) => sum + drop.run(id).changes, 0);
      return { removed, unpublished: levelIds.map(refreshLevel).filter(Boolean) };
    });
  }

  /**
   * Moves questions into a level, out of any other level that held them (a
   * question belongs to one level). `{ moved, unplaced, unpublished }` or `{ error }`.
   */
  function moveQuestionsToLevel(ids, levelId) {
    const target = getLevel(Number(levelId));
    if (!target) return { error: 'Choose a level to move them to.' };
    const clean = cleanIds(ids);
    if (!clean.length) return { error: 'Select at least one question.' };
    return tx(() => {
      const inTarget = new Set(db.prepare('SELECT question_id FROM level_words WHERE level_id = ?').all(target.id).map((r) => r.question_id));
      const toMove = clean.filter((id) => !inTarget.has(id));
      const { unpublished } = removeQuestionsFromLevels(toMove);
      const add = db.prepare('INSERT INTO level_words (level_id, question_id) SELECT ?, id FROM questions WHERE id = ?');
      const moved = toMove.reduce((sum, id) => sum + add.run(target.id, id).changes, 0);
      const targetUnpublished = refreshLevel(target.id);
      return {
        moved,
        level: getLevel(target.id),
        unplaced: getLevel(target.id).unplaced.length,
        unpublished: [...unpublished, ...(targetUnpublished ? [targetUnpublished] : [])],
      };
    });
  }

  /** A new level (at the end) made of these questions. `{ level, moved, unplaced, unpublished }` or `{ error }`. */
  function newLevelFromQuestions(ids) {
    if (!cleanIds(ids).length) return { error: 'Select at least one question.' };
    return tx(() => moveQuestionsToLevel(ids, createLevel().id));
  }

  /** Gives every question the same title (its word-search theme). `{ updated }` or `{ error }`. */
  function setQuestionsTitle(ids, rawTitle) {
    const title = String(rawTitle ?? '').trim();
    if (!title) return { error: 'Write the title to give them.' };
    if ([...title].length > MAX_TITLE) return { error: `A title can be at most ${MAX_TITLE} characters.` };
    const clean = cleanIds(ids);
    return tx(() => {
      const set = db.prepare("UPDATE questions SET title = ?, updated_at = datetime('now') WHERE id = ?");
      const updated = clean.reduce((sum, id) => sum + set.run(title, id).changes, 0);
      clean.forEach(touchLevelsUsing);
      return { updated };
    });
  }

  /**
   * Deletes questions that are in no level; those in a level are kept and
   * counted in `kept`. `{ deleted, kept, files: [media names to remove] }`.
   */
  function deleteQuestions(ids) {
    return tx(() => {
      let deleted = 0;
      let kept = 0;
      const files = [];
      for (const id of cleanIds(ids)) {
        if (!getQuestion(id)) continue;
        const result = deleteQuestion(id);
        if (result.error) {
          kept += 1;
          continue;
        }
        deleted += 1;
        files.push(...[result.imageFile, result.audioFile].filter(Boolean));
      }
      return { deleted, kept, files };
    });
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

  // levels.title is unused legacy: a level is named by its place ("Level 3").
  const toLevel = (row) => row && ({
    id: row.id,
    position: row.position,
    published: Boolean(row.published),
    seed: row.seed,
    rows: row.grid_rows,
    cols: row.grid_cols,
    updatedAt: iso(row.updated_at),
    wordCount: row.word_count ?? 0,
    unplacedCount: row.unplaced_count ?? 0,
    difficulty: DIFFICULTIES.includes(row.difficulty) ? row.difficulty : 'medium',
  });

  // levels.pack_id is a legacy column from removed packs; nothing reads it.
  const LEVEL_SELECT = `SELECT l.*,
      (SELECT COUNT(*) FROM level_words lw WHERE lw.level_id = l.id) AS word_count,
      (SELECT COUNT(*) FROM level_words lw WHERE lw.level_id = l.id AND lw.direction IS NULL) AS unplaced_count
    FROM levels l`;

  /**
   * Every level in panel order. `number` is its place in this list (the panel's
   * "Level 3"); `publishedNumber` is the number the app shows, null for a draft.
   */
  function listLevels() {
    let shown = 0;
    return db.prepare(`${LEVEL_SELECT} ORDER BY l.position, l.id`).all().map((row, i) => {
      const level = toLevel(row);
      const numbers = { number: i + 1, publishedNumber: level.published ? ++shown : null };
      return { ...level, ...numbers, name: levelName(numbers) };
    });
  }

  function getLevel(id) {
    const level = listLevels().find((l) => l.id === Number(id));
    if (!level) return null;
    const words = wordsOf(level.id);
    return { ...level, words: words.filter((w) => w.direction), unplaced: words.filter((w) => !w.direction) };
  }

  /** The level at a panel number (1-based), or null. */
  function levelByNumber(number) {
    const level = listLevels()[Number(number) - 1];
    return level ? getLevel(level.id) : null;
  }

  /** A validated difficulty, or `{ error }`. */
  function readLevelDetails({ difficulty } = {}) {
    const level = difficulty ?? 'medium';
    if (!DIFFICULTIES.includes(level)) return { error: `The difficulty is one of: ${DIFFICULTIES.join(', ')}.` };
    return { difficulty: level };
  }

  /** Adds the next level at the end of the list. Levels have no names; the legacy title stays empty. */
  function createLevel(details = {}) {
    const { difficulty, error } = readLevelDetails(details);
    // Callers check details first; reaching here with bad ones is a bug, not input.
    if (error) throw new Error(error);
    const { next } = db.prepare('SELECT IFNULL(MAX(position), 0) + 1 AS next FROM levels').get();
    const { lastInsertRowid } = db.prepare("INSERT INTO levels (title, position, difficulty) VALUES ('', ?, ?)")
      .run(next, difficulty);
    return getLevel(lastInsertRowid);
  }

  function setLevelDetails(id, details) {
    const { difficulty, error } = readLevelDetails(details);
    if (error) return { error };
    db.prepare("UPDATE levels SET difficulty = ?, updated_at = datetime('now') WHERE id = ?")
      .run(difficulty, id);
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

  /** Ids of questions already placed in a level other than `levelId`. */
  function usedElsewhere(levelId) {
    return new Set(db.prepare('SELECT question_id FROM level_words WHERE level_id <> ?')
      .all(levelId).map((r) => r.question_id));
  }

  /** The questions a level may use: those in no level yet, plus its own. */
  function questionsForLevel(levelId) {
    const taken = usedElsewhere(levelId);
    return listQuestions().filter((q) => !taken.has(q.id));
  }

  /**
   * Sets a level's questions. A question belongs to one level only, so any id
   * already in another level is left out and reported in `skipped`.
   */
  function setLevelQuestions(id, questionIds) {
    const requested = [...new Set(questionIds.map(Number).filter(Number.isInteger))];
    return tx(() => {
      const taken = usedElsewhere(id);
      const skipped = requested.filter((qid) => taken.has(qid));
      const ids = requested.filter((qid) => !taken.has(qid));
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
      return { layout, unpublished, skipped };
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
   * Sorts every level together: easy, then medium, then hard; within each,
   * fewer words first, then the order they were already in.
   *
   * Returns how many levels changed place.
   */
  function orderByDifficulty() {
    const levels = listLevels();
    const rank = (d) => DIFFICULTIES.indexOf(d);
    const order = levels
      .map((level, index) => ({ level, index }))
      .sort((a, b) =>
        rank(a.level.difficulty) - rank(b.level.difficulty)
        || a.level.wordCount - b.level.wordCount
        || a.index - b.index)
      .map(({ level }) => level.id);

    const moved = order.filter((levelId, k) => levelId !== levels[k].id).length;
    tx(() => writeOrder(order));
    return moved;
  }

  // ── What the app sees ─────────────────────────────────────────────────────

  /** Published levels in app order, each with its public summary. */
  function publishedEntries() {
    const rows = db.prepare(`${LEVEL_SELECT} WHERE l.published = 1 ORDER BY l.position, l.id`).all().map(toLevel);
    return rows.map((level, i) => ({
      id: level.id,
      summary: {
        number: i + 1,
        // Compatibility only: the app builds its own title from the number.
        title: appLevelTitle(i + 1),
        wordCount: level.wordCount,
        rows: level.rows,
        cols: level.cols,
        updatedAt: level.updatedAt,
        difficulty: level.difficulty,
      },
    }));
  }

  /** Summaries in app order: one numbered run. */
  function publishedLevels() {
    return publishedEntries().map((e) => e.summary);
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
    /** Runs `fn` in one transaction; nested calls become savepoints. */
    transaction: (fn) => tx(fn),
    credited, listQuestions, getQuestion, checkQuestion, createQuestion, updateQuestion, deleteQuestion, levelsUsing, mediaInUse,
    removeQuestionsFromLevels, moveQuestionsToLevel, newLevelFromQuestions, setQuestionsTitle, deleteQuestions,
    listLevels, getLevel, levelByNumber, createLevel, setLevelDetails, setLevelQuestions, questionsForLevel, shuffleLevel,
    setPublished, deleteLevel, moveLevel, orderByDifficulty,
    publishedLevels, publishedLevelIds, publishedLevel, publishedLevelById, counts,
  };
}
