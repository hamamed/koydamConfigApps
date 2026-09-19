import assert from 'node:assert/strict';
import test from 'node:test';

import { openDatabase } from '../src/db/index.js';
import { MIN_CATEGORIES, planLevels, wordsCross } from '../src/level-builder.js';
import { createRepository } from '../src/repository.js';

const question = (id, title, answer) => ({ id, title, answer, playAnswer: answer });

test('a level takes one question from each chosen category', () => {
  const questions = [
    question(1, 'علم', 'امريكا'), question(2, 'علم', 'ايطاليا'),
    question(3, 'ضد', 'كبير'), question(4, 'ضد', 'بعيد'),
    question(5, 'مرادف', 'فرح'), question(6, 'مرادف', 'سعيد'),
  ];
  const { levels, ranOutOf, noCrossing } = planLevels({ questions, categories: ['علم', 'ضد', 'مرادف'], count: 2 });
  assert.equal(levels.length, 2);
  assert.equal(ranOutOf, null);
  assert.equal(noCrossing, false);
  for (const level of levels) {
    assert.deepEqual(level.map((q) => q.title).sort(), ['ضد', 'علم', 'مرادف'].sort());
    assert.ok(wordsCross(level), 'the words of a planned level cross');
  }
  // No question is used twice: a question belongs to one level.
  const used = levels.flat().map((q) => q.id);
  assert.equal(new Set(used).size, used.length);
});

test('planning stops at the category that runs out, and says which', () => {
  const questions = [
    question(1, 'علم', 'امريكا'), question(2, 'علم', 'المانيا'),
    question(3, 'ضد', 'كبير'),
  ];
  const { levels, ranOutOf } = planLevels({ questions, categories: ['علم', 'ضد'], count: 3 });
  assert.equal(levels.length, 1);
  assert.equal(ranOutOf, 'ضد');
});

test('one category is refused: a lone word has nothing to cross', () => {
  const { error, levels } = planLevels({ questions: [question(1, 'علم', 'امريكا')], categories: ['علم'], count: 1 });
  assert.match(error, /at least 2 categories/);
  assert.deepEqual(levels, []);
  assert.equal(MIN_CATEGORIES, 2);
});

test('no set that crosses is reported as such, not as an empty category', () => {
  const questions = [question(1, 'علم', 'امريكا'), question(2, 'ضد', 'طظغ')];
  const { levels, noCrossing, ranOutOf } = planLevels({ questions, categories: ['علم', 'ضد'], count: 1 });
  assert.deepEqual(levels, []);
  assert.equal(noCrossing, true);
  assert.equal(ranOutOf, null);
});

test('a word that crosses nothing is left behind instead of blocking the plan', () => {
  const questions = [
    question(1, 'علم', 'امريكا'),
    // No letter in common with the rest, so no set holding it can be laid out.
    question(2, 'ضد', 'طظغ'),
    question(3, 'ضد', 'كبير'),
  ];
  const { levels } = planLevels({ questions, categories: ['علم', 'ضد'], count: 1 });
  assert.equal(levels.length, 1);
  assert.deepEqual(levels[0].map((q) => q.id).sort(), [1, 3]);
});

test('the same seed plans the same levels', () => {
  const questions = [
    question(1, 'علم', 'امريكا'), question(2, 'علم', 'المانيا'),
    question(3, 'ضد', 'كبير'), question(4, 'ضد', 'قريب'),
  ];
  const plan = (seed) => planLevels({ questions, categories: ['علم', 'ضد'], count: 2, seed })
    .levels.map((level) => level.map((q) => q.id));
  assert.deepEqual(plan(7), plan(7));
});

test('nothing free in a category plans nothing', () => {
  const { levels, ranOutOf } = planLevels({ questions: [], categories: ['علم', 'ضد'], count: 2 });
  assert.deepEqual(levels, []);
  assert.equal(ranOutOf, 'علم');
});

test('a planned level can be built from the bank, and its words all cross', () => {
  const repo = createRepository(openDatabase(':memory:'));
  const bank = [
    ['ضد', ['كبير', 'بعيد', 'قصير']],
    ['مرادف', ['سعيد', 'كريم', 'فرح']],
    ['معلومات عامة', ['الرباط', 'دمشق', 'طبيب']],
  ];
  bank.forEach(([title, answers]) => answers.forEach((answer) => {
    const made = repo.createQuestion({ answer, clue: 'سؤال', title, difficulty: 'easy' });
    assert.equal(made.error, undefined);
  }));

  const free = repo.listQuestions({ unused: true });
  const { levels } = planLevels({ questions: free, categories: bank.map(([title]) => title), count: 2, seed: 3 });
  assert.equal(levels.length, 2);

  levels.forEach((words) => {
    const result = repo.newLevelFromQuestions(words.map((w) => w.id));
    assert.equal(result.error, undefined);
    const level = repo.getLevel(result.level.id);
    assert.equal(level.unplaced.length, 0, 'a generated level is ready to publish');
    assert.equal(level.words.length, 3);
    assert.deepEqual([...new Set(level.words.map((w) => w.title))].sort(), bank.map(([t]) => t).sort());
  });
  // The six questions used are no longer free for another level.
  assert.equal(repo.listQuestions({ unused: true }).length, 3);
});

test('a word is never used twice, in one level or across the levels', () => {
  // جميل is both an opposite and a synonym: two questions, one word.
  const questions = [
    question(1, 'ضد', 'جميل'), question(2, 'ضد', 'كبير'),
    question(3, 'مرادف', 'جميل'), question(4, 'مرادف', 'سعيد'),
    question(5, 'معلومات عامة', 'الرباط'), question(6, 'معلومات عامة', 'دمشق'),
  ];
  const { levels } = planLevels({ questions, categories: ['ضد', 'مرادف', 'معلومات عامة'], count: 2 });
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
    questions, categories: ['ضد', 'مرادف'], count: 2, usedAnswers: ['كبير', 'سعيد'],
  });
  const used = levels.flat().map((q) => q.answer);
  assert.deepEqual(used.sort(), ['بعيد', 'كريم'].sort());
});
