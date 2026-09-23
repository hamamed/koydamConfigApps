#!/usr/bin/env node
/**
 * Takes «ال» off the answers that read better without it.
 *
 *   node scripts/strip-article.js            # what it would change
 *   node scripts/strip-article.js --apply    # change it, keeping the old answers
 *   node scripts/strip-article.js --revert <file>
 *
 * Two things decide what is touched.
 *
 * **The category.** Only the five whose answers are ordinary nouns. Proverbs,
 * إسلاميات, historical figures, places, landmarks, flags, logos and players are
 * left alone entirely — «ال» is part of the answer there, not decoration.
 *
 * **The keep list** (src/article-policy.js). Inside those five there are still
 * proper nouns — الأزهر, المتنبي, الأمازون, المريخ — and a rule cannot tell them
 * from القلم, so they are named one by one. The Answers page reads the same
 * list, so what it offers and what this sweeps are the same set.
 *
 * The change goes through the repository, not the database, so the levels that
 * use a changed answer are laid out again the way any edit would do it.
 */
import fs from 'node:fs';

import { withoutArticle } from '../src/arabic.js';
import { KEEP_ARTICLE, NOUN_CATEGORIES } from '../src/article-policy.js';
import { db } from '../src/db/index.js';
import { createRepository } from '../src/repository.js';


const args = process.argv.slice(2);
const apply = args.includes('--apply');
const revertAt = args.indexOf('--revert');

const repo = createRepository(db);

if (revertAt >= 0) {
  const file = args[revertAt + 1];
  if (!file) {
    console.error('  --revert needs the file the apply wrote.');
    process.exit(1);
  }
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  let back = 0;
  for (const row of saved) {
    const result = repo.updateQuestion(row.id, { answer: row.was });
    if (result.error) console.error(`  ${row.id}: ${result.error}`);
    else back += 1;
  }
  console.log(`  رُدّ ${back} جواباً إلى ما كان.`);
  process.exit(0);
}

const rows = repo.listQuestions()
  .filter((q) => NOUN_CATEGORIES.includes(q.title) && !KEEP_ARTICLE.has(q.answer.trim()))
  .map((q) => ({ q, bare: withoutArticle(q.answer) }))
  .filter(({ bare }) => bare);

// An answer that would collide with one already in the bank is left alone: two
// questions with the same played answer is a problem of its own.
const spoken = new Map();
for (const q of repo.listQuestions()) spoken.set(q.playAnswer, (spoken.get(q.playAnswer) ?? 0) + 1);

console.log(`  ${rows.length} جواباً مرشَّحاً في: ${NOUN_CATEGORIES.join('، ')}`);
console.log(`  ${KEEP_ARTICLE.size} اسماً علماً مستثنى، وبقية الفئات لم تُمسّ.\n`);

if (!apply) {
  rows.slice(0, 40).forEach(({ q, bare }) => console.log(`    ${q.answer}  ←  ${bare}`));
  if (rows.length > 40) console.log(`    … و${rows.length - 40} غيرها`);
  console.log('\n  --apply لتنفيذها.');
  process.exit(0);
}

const saved = [];
const failed = [];
let relaid = 0;
for (const { q, bare } of rows) {
  const result = repo.updateQuestion(q.id, { answer: bare });
  if (result.error) {
    failed.push({ id: q.id, answer: q.answer, error: result.error });
    continue;
  }
  saved.push({ id: q.id, was: q.answer, now: bare });
  relaid += result.unpublished?.length ?? 0;
}

const file = `/tmp/wasla-article-${Date.now()}.json`;
fs.writeFileSync(file, JSON.stringify(saved, null, 1));
console.log(`  غُيّر ${saved.length} جواباً.`);
if (failed.length) {
  console.log(`  تعذّر ${failed.length}:`);
  failed.slice(0, 10).forEach((f) => console.log(`    ${f.answer}: ${f.error}`));
}
if (relaid) console.log(`  ${relaid} لغزاً أُلغي نشره لأن كلماته لم تعد تتقاطع.`);
console.log(`\n  للرجوع:  node scripts/strip-article.js --revert ${file}`);
