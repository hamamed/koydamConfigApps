/**
 * Adds the questions written in `scripts/questions-seed.txt` to the bank.
 *
 *   npm run seed-questions -- --check   # says what it would add and what it would skip
 *   npm run seed-questions              # adds them
 *
 * A line is `الجواب | الدليل | الصعوبة`, under a `@ الفئة` heading. A question
 * whose answer is already in that category is skipped, so the file can be run
 * again after it grows.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeAnswer } from '../src/arabic.js';
import { db } from '../src/db/index.js';
import { createRepository } from '../src/repository.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(HERE, 'questions-seed.txt');

/** What a line may say a question's difficulty is. */
const DIFFICULTY = Object.freeze({
  سهل: 'easy', متوسط: 'medium', صعب: 'hard', easy: 'easy', medium: 'medium', hard: 'hard',
});

/** `{ questions, problems }` — one question per line, under its category. */
export function readSeed(text) {
  const questions = [];
  const problems = [];
  const seen = new Set();
  let title = '';
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    if (line.startsWith('@')) {
      title = line.slice(1).trim();
      return;
    }
    const at = `سطر ${index + 1}`;
    const [answer, clue, level] = line.split('|').map((part) => part.trim());
    if (!title) return problems.push(`${at}: «${answer}» قبل أي فئة`);
    if (!answer || !clue) return problems.push(`${at}: السطر ثلاثة أجزاء: الجواب | الدليل | الصعوبة`);
    if (level && !DIFFICULTY[level]) return problems.push(`${at}: «${level}» ليست صعوبة`);
    const key = `${title}|${normalizeAnswer(answer)}`;
    if (seen.has(key)) return problems.push(`${at}: «${answer}» مكتوب مرتين في «${title}»`);
    seen.add(key);
    questions.push({ title, answer, clue, difficulty: DIFFICULTY[level] ?? 'medium' });
  });
  return { questions, problems };
}

const check = process.argv.includes('--check');
const { questions, problems } = readSeed(await fs.readFile(SEED, 'utf8'));
problems.forEach((problem) => console.error(`✗ ${problem}`));
console.log(`${questions.length} questions read, ${problems.length} problems`);

const repo = createRepository(db);
// What the bank already has, by category and answer as it is played.
const have = new Set(repo.listQuestions().map((q) => `${q.title}|${normalizeAnswer(q.answer)}`));

const adding = questions.filter((q) => !have.has(`${q.title}|${normalizeAnswer(q.answer)}`));
const already = questions.length - adding.length;
const byTitle = adding.reduce((count, q) => count.set(q.title, (count.get(q.title) ?? 0) + 1), new Map());

console.log(`${adding.length} would be added, ${already} are in the bank already`);
for (const [title, count] of byTitle) console.log(`  ${title}: ${count}`);
if (check) process.exit(problems.length ? 1 : 0);
if (problems.length) {
  console.error('Nothing was added: fix the lines above first.');
  process.exit(1);
}

let added = 0;
for (const question of adding) {
  const { error } = repo.createQuestion({
    title: question.title,
    answer: question.answer,
    clue: question.clue,
    type: 'text',
    difficulty: question.difficulty,
  });
  if (error) console.error(`✗ «${question.answer}»: ${error}`);
  else added++;
}

const counts = repo.counts();
console.log(`added ${added}; the bank now holds ${counts.questions ?? '?'} questions`);
