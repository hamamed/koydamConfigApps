/**
 * Bulk import: one CSV of questions plus the pictures and sounds it names.
 *
 * Two steps. Upload checks every row with the same rules the question form
 * uses and shows what would happen; confirm imports the rows that passed, all
 * in one transaction, and lays out every level it touched. Nothing is written
 * to the question bank until confirm.
 */

import { parseCsv } from './csv.js';

export const IMPORT_COLUMNS = ['answer', 'clue', 'category', 'type', 'emoji', 'image', 'zoom', 'focus_x', 'focus_y', 'blurred', 'audio', 'level'];
/** Columns older CSVs may still carry; read past without complaint. `pack` is from removed level packs. */
const IGNORED_COLUMNS = ['pack'];
export const MAX_IMPORT_ROWS = 1000;
const MAX_LEVEL_TITLE = 80;

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
  for (const required of ['answer', 'clue']) {
    if (!header.includes(required)) return { error: `The header needs an “${required}” column.` };
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
  const levelsNamed = new Map();

  return rows.map(({ row, values, extra }) => {
    const plan = { row, answer: values.answer, clue: values.clue, error: null };
    const fail = (error) => ({ ...plan, error });
    if (extra) return fail(`${extra} more field${extra > 1 ? 's' : ''} than the header has columns — is a comma missing its quotes?`);

    const image = mediaFor(values.image, 'image', media);
    if (image.error) return fail(image.error);
    const audio = mediaFor(values.audio, 'audio', media);
    if (audio.error) return fail(audio.error);

    const levelTitle = (values.level ?? '').slice(0, MAX_LEVEL_TITLE);
    if (levelTitle && !levelsNamed.has(levelTitle)) levelsNamed.set(levelTitle, repo.findLevelByTitle(levelTitle));

    // Blank cells are left out, so the question's own defaults apply.
    const given = (value) => (value === undefined || value === '' ? undefined : value);
    const input = {
      answer: values.answer,
      clue: values.clue,
      category: values.category,
      type: given(values.type),
      emoji: values.emoji,
      imageFile: image.file,
      zoom: given(values.zoom),
      focusX: given(values.focus_x),
      focusY: given(values.focus_y),
      blurred: given(values.blurred),
      audioFile: audio.file,
    };
    const check = repo.checkQuestion(input);
    if (check.error) return fail(check.error);

    return {
      ...plan,
      input,
      playAnswer: check.question.playAnswer,
      storedAnswer: check.question.answer,
      type: check.question.type,
      levelTitle: levelTitle || null,
      levelIsNew: Boolean(levelTitle) && !levelsNamed.get(levelTitle),
    };
  });
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
      if (p.levelTitle) {
        const ids = byLevel.get(p.levelTitle) ?? [];
        byLevel.set(p.levelTitle, [...ids, created.question.id]);
      }
    }

    const levels = [...byLevel].map(([title, ids]) => {
      const existing = repo.findLevelByTitle(title);
      const level = existing ?? repo.createLevel(title);
      const current = [...level.words, ...level.unplaced].map((w) => w.id);
      const { layout, unpublished } = repo.setLevelQuestions(level.id, [...current, ...ids]);
      return { id: level.id, title, created: !existing, added: ids.length, unplaced: layout.unplaced.length, unpublished };
    });

    const usedFiles = valid.flatMap((p) => [p.input.imageFile, p.input.audioFile]).filter(Boolean);
    return { imported: valid.length, levels, usedFiles: [...new Set(usedFiles)] };
  });
}
