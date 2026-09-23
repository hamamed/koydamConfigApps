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
 * **The KEEP list.** Inside those five there are still proper nouns — الأزهر,
 * المتنبي, الأمازون, المريخ — and a rule cannot tell them from القلم. They are
 * named here one by one, because the alternative is a rule that quietly
 * mangles a hundred answers.
 *
 * The change goes through the repository, not the database, so the levels that
 * use a changed answer are laid out again the way any edit would do it.
 */
import fs from 'node:fs';

import { db } from '../src/db/index.js';
import { createRepository } from '../src/repository.js';

/** Answers here are ordinary nouns; everywhere else «ال» belongs to the answer. */
const CATEGORIES = ['معلومات عامة', 'رياضات', 'مرادف', 'النحو والإعراب', 'شخصيات كرتونية'];

/** Proper nouns inside those categories: names of people, places, works and bodies. */
const KEEP = new Set([
  // Places, countries, cities, rivers, mountains, seas
  'الأرجنتين', 'الأطلس', 'الأقصر', 'الألب', 'الأمازون', 'الأندلس', 'الأنديز', 'الإسكندرية',
  'الإمارات', 'البتراء', 'البحرين', 'البرازيل', 'البندقية', 'الجزائر', 'الحديبية', 'الخرطوم',
  'الدانوب', 'الدوحة', 'الرباط', 'الرياض', 'الزوراء', 'السعودية', 'السودان', 'السويد',
  'السيبيري', 'الشهباء', 'الصين', 'العراق', 'الغانج', 'الفاتيكان', 'الفرات', 'الفولغا',
  'الفيحاء', 'القادسية', 'القاهرة', 'القدس', 'القسطنطينية', 'القيروان', 'القرويين', 'الكرملين',
  'الكويت', 'الكولوسيوم', 'اللوفر', 'المحروسة', 'المغرب', 'المكسيك', 'المملكة', 'المنامة',
  'المتوسط', 'النيل', 'الهند', 'الهيمالايا', 'اليابان', 'اليرموك', 'اليمن', 'اليونان',
  'الخندق', 'الروضة', 'التايمز', 'البنتاغون',
  // Planets
  'المريخ', 'المشتري', 'الزهرة',
  // People, dynasties, peoples
  'الأصفهاني', 'الإدريسي', 'الإسكندر', 'البخاري', 'الخنساء', 'الخوارزمي', 'الرازي', 'الطبري',
  'السومريون', 'الفاطميون', 'الفراعنة', 'الفينيقيون', 'الليديون', 'المتنبي', 'المعري', 'المماليك',
  'المنصور', 'الأيوبية', 'الفاروق', 'القادر', 'الفاتح', 'العاص', 'الرشيد', 'المعتصم',
  // Works, awards, bodies, institutions
  'الأغاني', 'البخلاء', 'الإنجيل', 'المعلقات', 'المعلقة', 'المقامات', 'المقدمة', 'الموناليزا',
  'الأوسكار', 'اليونسكو', 'اليونيسف', 'الأزهر', 'النظامية', 'المستنصرية', 'البديع',
  // Quran chapters and Islamic proper nouns that slipped into general knowledge
  'الكوثر', 'التوبة', 'البقرة', 'النبوي', 'الهجرة', 'الطور',
  // Monuments and epithets that read as ordinary nouns once the article is off:
  // «الحمراء» is the palace, «الزيتونة» the mosque, «الصديق» أبو بكر.
  'الحمراء', 'الزيتونة', 'الصديق', 'العين', 'الفيصل', 'الكعبة',
]);

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

/** «الشمس» → «شمس»; null when it is not a plain one-word answer with the article. */
function stripped(answer) {
  const text = String(answer ?? '').trim();
  if (!text.startsWith('ال') || text.includes(' ')) return null;
  const bare = text.slice(2);
  // Two letters left is not a word anyone would answer with.
  return [...bare].length >= 3 ? bare : null;
}

const rows = repo.listQuestions()
  .filter((q) => CATEGORIES.includes(q.title) && !KEEP.has(q.answer.trim()))
  .map((q) => ({ q, bare: stripped(q.answer) }))
  .filter(({ bare }) => bare);

// An answer that would collide with one already in the bank is left alone: two
// questions with the same played answer is a problem of its own.
const spoken = new Map();
for (const q of repo.listQuestions()) spoken.set(q.playAnswer, (spoken.get(q.playAnswer) ?? 0) + 1);

console.log(`  ${rows.length} جواباً مرشَّحاً في: ${CATEGORIES.join('، ')}`);
console.log(`  ${KEEP.size} اسماً علماً مستثنى، وبقية الفئات لم تُمسّ.\n`);

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
