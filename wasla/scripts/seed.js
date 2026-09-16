/**
 * Adds the two sample levels from the prototype, marked easy and published —
 * enough for every v2 endpoint to answer. Safe to run twice: it does nothing
 * when levels exist.
 *
 *   npm run seed
 */
import { db } from '../src/db/index.js';
import { createRepository } from '../src/repository.js';

const repo = createRepository(db);

const LEVELS = [
  ['بلدان وعواصم', [
    ['المغرب', 'بلد عاصمته الرباط', 'بلدان'],
    ['عمان', 'عاصمة الأردن', 'عواصم'],
    ['مصر', 'بلد فيه الأهرامات ونهر النيل', 'بلدان'],
    ['باريس', 'عاصمة فرنسا', 'عواصم'],
  ]],
  ['أشياء من حولنا', [
    ['الشمس', 'نجم يضيء النهار', 'طبيعة'],
    ['شجرة', 'نبات له جذع وأغصان', 'طبيعة'],
    ['سمك', 'يعيش في الماء ويتنفس بالخياشيم', 'حيوانات'],
    ['كلب', 'حيوان وفيّ يحرس البيت', 'حيوانات'],
    ['كرة', 'نلعب بها في الملعب', 'أشياء'],
    ['كتاب', 'نقرأ فيه ونتعلم', 'أشياء'],
  ]],
];

if (repo.listLevels().length) {
  console.log('  Levels already exist; nothing seeded.');
  process.exit(0);
}

for (const [title, questions] of LEVELS) {
  const ids = questions.map(([answer, clue, category]) => {
    const result = repo.createQuestion({ answer, clue, category });
    if (result.error) throw new Error(`${answer}: ${result.error}`);
    return result.question.id;
  });
  const level = repo.createLevel(title, { difficulty: 'easy' });
  const { layout } = repo.setLevelQuestions(level.id, ids);
  const published = repo.setPublished(level.id, true);
  console.log(`  ${title}: ${layout.placements.length} words, ${layout.rows}×${layout.cols}${published.error ? ` — not published: ${published.error}` : ''}`);
}
