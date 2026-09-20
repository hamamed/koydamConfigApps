import assert from 'node:assert/strict';
import test from 'node:test';

import { openDatabase } from '../src/db/index.js';
import {
  LEVEL_SIZE, MAIN_CATEGORY, MAIN_SLOTS, MAX_LETTERS, MIN_CATEGORIES,
  gradeSet, planLevels, wordsCross,
} from '../src/level-builder.js';
import { createRepository } from '../src/repository.js';

const question = (id, title, answer) => ({ id, title, answer, playAnswer: answer });

/** Enough short, well-crossing answers per category to plan a few levels from. */
function bank(categories, per = 12) {
  const answers = [
    'كبير', 'بعيد', 'قصير', 'سعيد', 'كريم', 'فرح', 'رباط', 'دمشق', 'طبيب', 'قلم',
    'مطر', 'بحر', 'شمس', 'كتاب', 'مدرس', 'ماء', 'سمير', 'رسام', 'جبل', 'نهر',
  ];
  // One letter apiece keeps every category's words its own and every answer short.
  const mark = ['', 'ا', 'ه', 'ي', 'ن', 'ت', 'م', 'ل', 'س', 'د'];
  let id = 0;
  return categories.flatMap((title, at) => answers.slice(0, per).map((answer) => (
    question((id += 1), title, `${answer}${mark[at % mark.length]}`)
  )));
}

test('a level holds ten questions, two of them معلومات عامة', () => {
  const questions = bank([MAIN_CATEGORY, 'ضد', 'مرادف', 'علم', 'حيوانات', 'شعارات', 'سيارات', 'معالم', 'لاعب']);
  const { levels } = planLevels({ questions, count: 2, seed: 5 });

  assert.equal(levels.length, 2);
  assert.equal(LEVEL_SIZE, 10);
  for (const level of levels) {
    assert.equal(level.length, LEVEL_SIZE);
    assert.equal(level.filter((q) => q.title === MAIN_CATEGORY).length, MAIN_SLOTS);
    assert.ok(wordsCross(level), 'the words of a planned level cross');
  }
});

test('the other categories are drawn at random, so two levels are not the same mix', () => {
  const questions = bank([MAIN_CATEGORY, 'ضد', 'مرادف', 'علم', 'حيوانات', 'شعارات', 'سيارات', 'معالم', 'لاعب'], 20);
  const { levels } = planLevels({ questions, count: 4, size: 5, seed: 11 });

  assert.equal(levels.length, 4);
  const mixes = new Set(levels.map((level) => [...new Set(level.map((q) => q.title))].sort().join('+')));
  assert.ok(mixes.size > 1, 'the categories differ from one level to the next');
  // Whatever the draw, the general-knowledge pair is in every one of them.
  levels.forEach((level) => assert.equal(level.filter((q) => q.title === MAIN_CATEGORY).length, MAIN_SLOTS));
});

test('only the categories asked for are drawn from', () => {
  const questions = bank([MAIN_CATEGORY, 'ضد', 'مرادف', 'علم']);
  const { levels } = planLevels({ questions, categories: ['ضد', 'مرادف'], count: 1, size: 4, seed: 2 });

  assert.equal(levels.length, 1);
  assert.deepEqual([...new Set(levels[0].map((q) => q.title))].sort(), ['ضد', 'مرادف'].sort());
});

test('a level of fewer than two questions is refused: a lone word has nothing to cross', () => {
  const { error, levels } = planLevels({ questions: bank(['ضد', 'مرادف']), size: 1, count: 1 });
  assert.match(error, /at least 2 questions/);
  assert.deepEqual(levels, []);
  assert.equal(MIN_CATEGORIES, 2);
});

test('one category with free questions is refused as well', () => {
  const { error, levels } = planLevels({ questions: bank(['ضد']), count: 1, size: 4 });
  assert.match(error, /at least 2/);
  assert.deepEqual(levels, []);
});

test('an answer too long for a phone screen is left for a level built by hand', () => {
  const questions = [
    ...bank(['ضد', 'مرادف'], 6),
    question(900, 'ضد', 'الديموقراطيات'),
    question(901, 'مرادف', 'الاستراتيجيات'),
  ];
  const { levels } = planLevels({ questions, count: 2, size: 4, seed: 4 });
  const used = levels.flat().map((q) => q.playAnswer);
  assert.ok(used.length, 'levels were planned');
  assert.ok(used.every((answer) => [...answer].length <= MAX_LETTERS));
});

test('the same seed plans the same levels', () => {
  const questions = bank([MAIN_CATEGORY, 'ضد', 'مرادف', 'علم']);
  const plan = (seed) => planLevels({ questions, count: 2, size: 4, seed })
    .levels.map((level) => level.map((q) => q.id));
  assert.deepEqual(plan(7), plan(7));
});

test('the main category running out stops the plan, and is named', () => {
  const questions = [
    ...bank(['ضد', 'مرادف', 'علم'], 12),
    // Only enough for one level's pair.
    question(500, MAIN_CATEGORY, 'قمرا'), question(501, MAIN_CATEGORY, 'بحرا'),
  ];
  const { levels, ranOutOf } = planLevels({ questions, count: 3, size: 4, seed: 6 });
  assert.equal(levels.length, 1);
  assert.equal(ranOutOf, MAIN_CATEGORY);
});

test('a bank with nothing left for another level says so', () => {
  const questions = bank(['ضد', 'مرادف'], 3);
  const { levels, ranOut } = planLevels({ questions, count: 4, size: 4, seed: 8 });
  assert.equal(levels.length, 1);
  assert.equal(ranOut, true);
});

test('no set that crosses is reported as such, not as an empty bank', () => {
  const questions = [
    question(1, 'ضد', 'امريكا'), question(2, 'ضد', 'طظغ'),
    question(3, 'مرادف', 'ذشظ'), question(4, 'مرادف', 'ثخغ'),
  ];
  const { levels, noCrossing, ranOut } = planLevels({ questions, count: 1, size: 3, seed: 1 });
  assert.deepEqual(levels, []);
  assert.equal(noCrossing, true);
  assert.equal(ranOut, false);
});

test('a word is never used twice, in one level or across the levels', () => {
  // جميل is both an opposite and a synonym: two questions, one word.
  const questions = [
    question(1, 'ضد', 'جميل'), question(2, 'ضد', 'كبير'), question(3, 'ضد', 'قصير'),
    question(4, 'مرادف', 'جميل'), question(5, 'مرادف', 'سعيد'), question(6, 'مرادف', 'كريم'),
    question(7, 'علم', 'الرباط'), question(8, 'علم', 'دمشق'), question(9, 'علم', 'طبيب'),
  ];
  const { levels } = planLevels({ questions, count: 2, size: 3, seed: 9 });
  assert.ok(levels.length >= 1);
  levels.forEach((level) => {
    const words = level.map((q) => q.playAnswer);
    assert.equal(new Set(words).size, words.length, 'one level shows a word once');
  });
  const all = levels.flat().map((q) => q.playAnswer);
  assert.equal(new Set(all).size, all.length, 'no level repeats another level\'s word');
});

test('a word an earlier level already uses is not offered again', () => {
  const questions = [
    question(1, 'ضد', 'كبير'), question(2, 'ضد', 'بعيد'),
    question(3, 'مرادف', 'سعيد'), question(4, 'مرادف', 'كريم'),
  ];
  const { levels } = planLevels({
    questions, count: 1, size: 2, seed: 1, usedAnswers: ['كبير', 'سعيد'],
  });
  const used = levels.flat().map((q) => q.answer);
  assert.deepEqual(used.sort(), ['بعيد', 'كريم'].sort());
});

test('a planned level can be built from the bank, and its words all cross', () => {
  const repo = createRepository(openDatabase(':memory:'));
  const titles = [MAIN_CATEGORY, 'ضد', 'مرادف', 'علم'];
  bank(titles, 8).forEach(({ title, playAnswer }) => {
    const made = repo.createQuestion({ answer: playAnswer, clue: 'سؤال', title, difficulty: 'easy' });
    assert.equal(made.error, undefined);
  });

  const { levels } = planLevels({ questions: repo.listQuestions({ unused: true }), count: 2, size: 4, seed: 3 });
  assert.equal(levels.length, 2);

  levels.forEach((words) => {
    const result = repo.newLevelFromQuestions(words.map((w) => w.id));
    assert.equal(result.error, undefined);
    const level = repo.getLevel(result.level.id);
    assert.equal(level.unplaced.length, 0, 'a generated level is ready to publish');
    assert.equal(level.words.length, 4);
    assert.equal(level.words.filter((w) => w.title === MAIN_CATEGORY).length, MAIN_SLOTS);
  });
  // The questions used are no longer free for another level.
  assert.equal(repo.listQuestions({ unused: true }).length, titles.length * 8 - 8);
});

test('a set that cannot be laid out is graded as no level at all', () => {
  assert.equal(gradeSet([question(1, 'ضد', 'كبير'), question(2, 'مرادف', 'طظغ')]), null);
  assert.ok(gradeSet([question(1, 'ضد', 'كبير'), question(2, 'مرادف', 'سمير')]).crossings >= 1);
});
