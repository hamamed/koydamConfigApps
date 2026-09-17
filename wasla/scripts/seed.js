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

// Levels have no names: they are "Level 1", "Level 2" by their order. Each
// question: answer, clue, title (shown above the question in the app).
const LEVELS = [
  [
    ['المغرب', 'بلد عاصمته الرباط', 'بلدان'],
    ['عمان', 'عاصمة الأردن', 'عواصم'],
    ['مصر', 'بلد فيه الأهرامات ونهر النيل', 'بلدان'],
    ['باريس', 'عاصمة فرنسا', 'عواصم'],
  ],
  [
    ['الشمس', 'نجم يضيء النهار', 'طبيعة'],
    ['شجرة', 'نبات له جذع وأغصان', 'طبيعة'],
    ['سمك', 'يعيش في الماء ويتنفس بالخياشيم', 'حيوانات'],
    ['كلب', 'حيوان وفيّ يحرس البيت', 'حيوانات'],
    ['كرة', 'نلعب بها في الملعب', 'أشياء'],
    ['كتاب', 'نقرأ فيه ونتعلم', 'أشياء'],
  ],
];

if (repo.listLevels().length) {
  console.log('  Levels already exist; nothing seeded.');
  process.exit(0);
}

for (const questions of LEVELS) {
  const ids = questions.map(([answer, clue, title]) => {
    const result = repo.createQuestion({ answer, clue, title });
    if (result.error) throw new Error(`${answer}: ${result.error}`);
    return result.question.id;
  });
  const level = repo.createLevel({ difficulty: 'easy' });
  const { layout } = repo.setLevelQuestions(level.id, ids);
  const published = repo.setPublished(level.id, true);
  console.log(`  ${level.name}: ${layout.placements.length} words, ${layout.rows}×${layout.cols}${published.error ? ` — not published: ${published.error}` : ''}`);
}
