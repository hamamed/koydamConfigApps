/**
 * Bulk import: one CSV of questions plus the pictures and sounds it names.
 *
 * Two steps. Upload checks every row with the same rules the question form
 * uses and shows what would happen; confirm imports the rows that passed, all
 * in one transaction, and lays out every level it touched. Nothing is written
 * to the question bank until confirm.
 */

import { parseCsv } from './csv.js';
import { levelLabel } from './level-label.js';

export const IMPORT_COLUMNS = ['answer', 'clue', 'title', 'type', 'emoji', 'image', 'zoom', 'focus_x', 'focus_y', 'blurred',
  'audio', 'level', 'image_author', 'image_licence', 'image_source', 'difficulty'];
/**
 * Columns older CSVs may still carry; read past without complaint. `pack` is
 * from removed level packs. `category` was replaced by `title`, and stands in
 * for a blank title so an old file still imports.
 */
const IGNORED_COLUMNS = ['pack', 'category'];
export const MAX_IMPORT_ROWS = 1000;

/** `{ rows: [{ row, values }] }` keyed by column name, or `{ error }` for the whole file. */
export function readImportCsv(text) {
  let table;
  try {
    table = parseCsv(text);
  } catch (err) {
    return { error: `The CSV could not be read. ${err.message}` };
  }
  if (!table.length) return { error: 'The CSV is empty. The first line must name the columns.' };

  const header = table[0].map((name) => name.trim().toLowerCase());
  const unknown = header.filter((name) => !IMPORT_COLUMNS.includes(name) && !IGNORED_COLUMNS.includes(name));
  if (unknown.length) return { error: `Unknown column${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. The columns are: ${IMPORT_COLUMNS.join(', ')}.` };
  const repeated = header.filter((name, i) => header.indexOf(name) !== i);
  if (repeated.length) return { error: `Column named twice: ${repeated.join(', ')}.` };
  for (const required of ['answer']) {
    if (!header.includes(required)) return { error: `The header needs an “${required}” column.` };
  }
  if (!header.includes('title') && !header.includes('category')) {
    return { error: 'The header needs a “title” column: every question has a title, shown above it in the app.' };
  }

  const body = table.slice(1);
  if (!body.length) return { error: 'The CSV has a header but no rows.' };
  if (body.length > MAX_IMPORT_ROWS) return { error: `At most ${MAX_IMPORT_ROWS} rows per import. Split the file.` };

  return {
    rows: body.map((fields, i) => ({
      row: i + 1,
      values: Object.fromEntries(header.map((name, k) => [name, (fields[k] ?? '').trim()])),
      ...(fields.length > header.length ? { extra: fields.length - header.length } : {}),
    })),
  };
}

/** The fields the preview lets the admin change before confirming. */
export const EDITABLE_COLUMNS = ['answer', 'clue', 'title', 'level'];

/**
 * Rows after the preview's edits: `edits` maps a row number to the new text of
 * any of EDITABLE_COLUMNS, `removed` lists row numbers to drop. Row numbers
 * stay as they were, so the admin can still match them to the file.
 */
export function editImportRows(rows, edits = new Map(), removed = []) {
  const gone = new Set(removed.map(Number));
  return rows
    .filter(({ row }) => !gone.has(row))
    .map((entry) => {
      const change = edits.get(entry.row);
      if (!change) return entry;
      const values = { ...entry.values };
      for (const column of EDITABLE_COLUMNS) {
        if (change[column] !== undefined) values[column] = String(change[column]).trim();
      }
      // An edited title replaces the old category stand-in.
      if (change.title !== undefined && 'category' in values) values.category = '';
      return { ...entry, values };
    });
}

/** The media a row names, or an error naming what is missing. */
function mediaFor(name, kind, media) {
  if (!name) return { file: null };
  const found = media.get(name.toLowerCase());
  const noun = kind === 'image' ? 'picture' : 'audio file';
  if (!found) return { error: `No file named “${name}” was uploaded with the CSV.` };
  if (found.kind !== kind) return { error: `“${name}” is not a ${noun}.` };
  return { file: found.file };
}

/**
 * What each row would become. `media` maps a lower-cased uploaded file name to
 * `{ kind: 'image' | 'audio', file }`, the name it was stored under.
 */
export function planImport(repo, rows, media) {
  const levelCount = repo.listLevels().length;
  const lastAllowed = lastNewLevel(rows, levelCount);
  // The same played answer with the same clue is the same question: already in the bank, or earlier in this file.
  const sameKey = (playAnswer, clue) => `${playAnswer}\u0000${String(clue ?? '').trim()}`;
  const inBank = new Set(repo.listQuestions().map((q) => sameKey(q.playAnswer, q.clue)));
  const seen = new Map();

  return rows.map(({ row, values, extra }) => {
    const plan = { row, answer: values.answer, clue: values.clue, error: null };
    const fail = (error) => ({ ...plan, error });
    if (extra) return fail(`${extra} more field${extra > 1 ? 's' : ''} than the header has columns — is a comma missing its quotes?`);

    const image = mediaFor(values.image, 'image', media);
    if (image.error) return fail(image.error);
    const audio = mediaFor(values.audio, 'audio', media);
    if (audio.error) return fail(audio.error);

    const level = readLevelNumber(values.level, levelCount, lastAllowed);
    if (level.error) return fail(level.error);

    // Blank cells are left out, so the question's own defaults apply.
    const given = (value) => (value === undefined || value === '' ? undefined : value);
    const input = {
      answer: values.answer,
      clue: values.clue,
      title: values.title || values.category,
      type: given(values.type),
      emoji: values.emoji,
      imageFile: image.file,
      zoom: given(values.zoom),
      focusX: given(values.focus_x),
      focusY: given(values.focus_y),
      blurred: given(values.blurred),
      audioFile: audio.file,
      imageAuthor: values.image_author,
      imageLicence: values.image_licence,
      imageSource: values.image_source,
      difficulty: values.difficulty,
    };
    const check = repo.checkQuestion(input);
    if (check.error) return fail(check.error);
    const key = sameKey(check.question.playAnswer, input.clue);
    if (inBank.has(key)) return fail('Already in the question bank.');
    if (seen.has(key)) return fail(`Same as row ${seen.get(key)}.`);
    seen.set(key, row);

    return {
      ...plan,
      input,
      playAnswer: check.question.playAnswer,
      storedAnswer: check.question.answer,
      type: check.question.type,
      title: check.question.title,
      levelNumber: level.number,
      levelName: level.number ? levelLabel(level.number) : null,
      levelIsNew: level.number > levelCount,
    };
  });
}

/**
 * The highest level number this file may use. New levels must follow on from the
 * last existing one without a gap, but one file may add several: 4, 5 and 6 after
 * level 3 are fine together; 6 without 4 and 5 is not.
 */
function lastNewLevel(rows, levelCount) {
  const used = new Set(rows
    .map(({ values }) => String(values.level ?? '').trim())
    .filter((text) => /^\d+$/.test(text))
    .map(Number));
  let last = levelCount;
  while (used.has(last + 1)) last += 1;
  return last;
}

/**
 * The `level` cell: blank for none, or a level number as the panel counts them
 * (1, 2, 3 …): an existing level, or a new one that follows on without a gap.
 */
function readLevelNumber(cell, levelCount, lastAllowed = levelCount) {
  const text = String(cell ?? '').trim();
  if (!text) return { number: null };
  if (!/^\d+$/.test(text) || Number(text) < 1) {
    return { error: `The level is a level number (1, 2, 3 …), not “${text}”.` };
  }
  const number = Number(text);
  if (number > lastAllowed) {
    return { error: `There is no ${levelLabel(number)}. ${lastAllowed ? `The last is ${levelLabel(lastAllowed)}; ` : 'There are no levels yet; '}use ${lastAllowed + 1} to add a new one.` };
  }
  return { number };
}

/**
 * Imports the rows that passed, in one transaction, then lays out each level
 * they were added to. A row that fails now (something changed since the
 * preview) throws and rolls the whole import back.
 */
export function commitImport(repo, plan) {
  const valid = plan.filter((p) => !p.error);

  return repo.transaction(() => {
    const byLevel = new Map();
    for (const p of valid) {
      const created = repo.createQuestion(p.input);
      if (created.error) throw Object.assign(new Error(`Row ${p.row}: ${created.error}`), { status: 400 });
      if (p.levelNumber) {
        const ids = byLevel.get(p.levelNumber) ?? [];
        byLevel.set(p.levelNumber, [...ids, created.question.id]);
      }
    }

    const levels = [...byLevel].sort(([a], [b]) => a - b).map(([number, ids]) => {
      const existing = repo.levelByNumber(number);
      // Levels are created in ascending order, so a new one is always the next number.
      if (!existing && number !== repo.listLevels().length + 1) {
        throw Object.assign(new Error(`There is no ${levelLabel(number)} any more.`), { status: 400 });
      }
      const level = existing ?? repo.createLevel();
      const current = [...level.words, ...level.unplaced].map((w) => w.id);
      const { layout, unpublished } = repo.setLevelQuestions(level.id, [...current, ...ids]);
      return {
        id: level.id, number, name: repo.getLevel(level.id).name, created: !existing,
        added: ids.length, unplaced: layout.unplaced.length, unpublished,
      };
    });

    const usedFiles = valid.flatMap((p) => [p.input.imageFile, p.input.audioFile]).filter(Boolean);
    return { imported: valid.length, levels, usedFiles: [...new Set(usedFiles)] };
  });
}
