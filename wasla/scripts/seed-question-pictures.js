/**
 * Gives the questions listed in `scripts/question-pictures.txt` the drawing of
 * their answer, instead of a photograph.
 *
 *   npm run seed-question-pictures -- --check   # says what it would change
 *   npm run seed-question-pictures -- --draw    # draws what is missing
 *   npm run seed-question-pictures              # changes the questions
 *
 * Some of the bank was photographs that read poorly as a question — a man in a
 * turban for «عمامة», hats on a market stall for «قبعة», figs on a tree for
 * «تين». The drawings the daily games are played on say the thing itself, and
 * the two banks share one file per drawing (src/drawings.js).
 *
 * Every question it changes is written to `question-pictures.backup.json`
 * beside the database first — the photograph's name and its credit — so a swap
 * can be undone by hand.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../src/config.js';
import { db } from '../src/db/index.js';
import { createRepository } from '../src/repository.js';
import { drawOrPlain, emojiNames, fileFor, sourceOf } from '../src/drawings.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIST = path.join(HERE, 'question-pictures.txt');

/** What a line may say a question's difficulty is. */
const DIFFICULTY = Object.freeze({
  سهل: 'easy', متوسط: 'medium', صعب: 'hard', easy: 'easy', medium: 'medium', hard: 'hard',
});

/**
 * `{ title, answer, source, difficulty, adding }` per line; `@ العنوان` sets
 * the title under it, and a line that starts with `+` adds the question when
 * the bank has no such answer yet. A third part is its difficulty.
 */
export function readList(text) {
  const wanted = [];
  const problems = [];
  let title = '';
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    if (line.startsWith('@')) {
      title = line.slice(1).trim();
      return;
    }
    const adding = line.startsWith('+');
    const [answer, source, level] = (adding ? line.slice(1) : line).split('|').map((part) => part.trim());
    if (!answer || !source) return problems.push(`سطر ${index + 1}: السطر جزآن مفصولان بـ |`);
    if (!title) return problems.push(`سطر ${index + 1}: «${answer}» قبل أي عنوان`);
    if (level && !DIFFICULTY[level]) {
      return problems.push(`سطر ${index + 1}: «${level}» ليست صعوبة — سهل أو متوسط أو صعب`);
    }
    wanted.push({ title, answer, source, difficulty: DIFFICULTY[level] ?? '', adding });
  });
  return { wanted, problems };
}

const check = process.argv.includes('--check');
const drawing = process.argv.includes('--draw');

const { wanted, problems } = readList(await fs.readFile(LIST, 'utf8'));
problems.forEach((problem) => console.error(`✗ ${problem}`));
console.log(`${wanted.length} questions listed, ${problems.length} problems`);

const names = await emojiNames();
const rows = db.prepare(`SELECT id, title, answer, image_file, image_author, image_licence, image_source, difficulty
  FROM questions WHERE title = ? AND answer = ?`);

const drawings = wanted.map((item) => ({ ...item, source: sourceOf(item.source, names) }));
drawings.filter((item) => !item.source)
  .forEach((item) => console.error(`✗ «${item.answer}»: no drawing named «${item.source}»`));

// Drawing asks nothing of the database: it runs where sharp is, and the files
// are carried to where the questions are.
if (drawing) {
  await fs.mkdir(config.imagesDir, { recursive: true });
  let drawn = 0;
  for (const item of drawings.filter((one) => one.source)) {
    const file = path.join(config.imagesDir, fileFor(item.source));
    if (await fs.access(file).then(() => true, () => false)) continue;
    const png = await drawOrPlain(item.source);
    if (!png) {
      console.error(`✗ «${item.answer}»: no drawing for ${item.source}`);
      continue;
    }
    await fs.writeFile(file, png);
    drawn++;
  }
  console.log(`drew ${drawn} into ${config.imagesDir}`);
  process.exit(0);
}

const jobs = [];
const adding = [];
for (const item of drawings.filter((one) => one.source)) {
  const question = rows.get(item.title, item.answer);
  if (question) {
    jobs.push({ ...item, question, file: fileFor(item.source) });
  } else if (item.adding) {
    adding.push({ ...item, file: fileFor(item.source) });
  } else {
    console.error(`✗ «${item.answer}»: no question with that answer under «${item.title}»`);
  }
}

const changing = jobs.filter((job) => job.question.image_file !== job.file);
// A question with no difficulty takes the one the file gives it; one that has
// a difficulty keeps it, since it may have been judged in the panel.
const grading = jobs.filter((job) => job.difficulty && !job.question.difficulty);
console.log(`${changing.length} questions would change, ${jobs.length - changing.length} already drawn,`
  + ` ${adding.length} would be added, ${grading.length} would be given a difficulty`);
if (check) {
  changing.forEach((job) => console.log(`  ${job.title} · ${job.answer}: ${job.question.image_file} → ${job.file}`));
  adding.forEach((job) => console.log(`  + ${job.title} · ${job.answer} (${job.difficulty || 'بلا صعوبة'})`));
  grading.forEach((job) => console.log(`  ~ ${job.title} · ${job.answer}: ${job.difficulty}`));
  process.exit(problems.length ? 1 : 0);
}

const missing = [];
for (const job of [...changing, ...adding]) {
  if (!await fs.access(path.join(config.imagesDir, job.file)).then(() => true, () => false)) missing.push(job);
}
if (missing.length) {
  console.error(`Nothing was changed: ${missing.length} drawings are not here yet (run --draw where sharp is).`);
  process.exit(1);
}

// What each question had, before anything is changed.
const backup = path.join(config.dataDir, 'question-pictures.backup.json');
const kept = JSON.parse(await fs.readFile(backup, 'utf8').catch(() => '[]'));
kept.push({
  at: new Date().toISOString(),
  questions: changing.map((job) => ({ ...job.question })),
});
await fs.writeFile(backup, JSON.stringify(kept, null, 1));

// A drawing is nobody's photograph: the credit it replaces goes with it, and
// the drawings' own licences are named on the credits page.
const update = db.prepare(`UPDATE questions
  SET type = 'image', image_file = ?, image_author = NULL, image_licence = NULL, image_source = NULL,
      updated_at = datetime('now')
  WHERE id = ?`);
const swap = db.transaction((list) => list.forEach((job) => update.run(job.file, job.question.id)));
swap(changing);

const grade = db.prepare('UPDATE questions SET difficulty = ? WHERE id = ?');
db.transaction((list) => list.forEach((job) => grade.run(job.difficulty, job.question.id)))(grading);

// New questions: the drawing is the whole question, as picture questions are.
const repo = createRepository(db);
let added = 0;
for (const job of adding) {
  const { error } = repo.createQuestion({
    title: job.title, answer: job.answer, type: 'image', imageFile: job.file, difficulty: job.difficulty,
  });
  if (error) console.error(`✗ «${job.answer}»: ${error}`);
  else added++;
}

console.log(`changed ${changing.length} questions, added ${added}, graded ${grading.length};`
  + ` what the changed ones had is in ${backup}`);
