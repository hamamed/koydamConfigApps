import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { openDatabase } from '../src/db/index.js';
import { createRepository } from '../src/repository.js';
import { createTitles, SUGGESTED_TITLES } from '../src/titles.js';

let db;
let repo;
let titles;

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = createRepository(db);
  titles = createTitles(db);
});

test('the suggested titles are added once, and a deleted one does not come back', () => {
  assert.equal(titles.list().length, SUGGESTED_TITLES.length);
  assert.ok(titles.names().includes('سيارات'));
  assert.ok(SUGGESTED_TITLES.every((name) => [...name].length <= 40));

  assert.deepEqual(titles.remove('سيارات'), {});
  const again = createTitles(db);
  assert.ok(!again.names().includes('سيارات'));
});

test('titles only on questions are listed too, with their counts', () => {
  repo.createQuestion({ title: 'ماركات ساعات', answer: 'رولكس', clue: 'ساعة سويسرية' });
  repo.createQuestion({ title: 'حيوانات', answer: 'قط', clue: 'يموء' });

  const byName = new Map(titles.list().map((t) => [t.name, t]));

  assert.deepEqual(byName.get('ماركات ساعات'), { name: 'ماركات ساعات', questions: 1, listed: false });
  assert.deepEqual(byName.get('حيوانات'), { name: 'حيوانات', questions: 1, listed: true });
});

test('adding takes lines or commas, skips what is there and refuses long names', () => {
  const result = titles.addMany('ماركات ساعات\nحيوانات، طائرات\n' + 'ع'.repeat(41));
  assert.equal(result.added, 2);
  assert.equal(result.existing, 1);
  assert.equal(result.errors.length, 1);
});

test('renaming renames every question, and a used title cannot be deleted', () => {
  const { question } = repo.createQuestion({ title: 'حيوانات', answer: 'قط', clue: 'يموء' });

  assert.match(titles.remove('حيوانات').error, /1 سؤال/);
  assert.deepEqual(titles.rename('حيوانات', ' حيوانات أليفة '), { renamed: 1 });
  assert.equal(repo.getQuestion(question.id).title, 'حيوانات أليفة');
  assert.ok(!titles.names().includes('حيوانات'));
  assert.match(titles.rename('حيوانات أليفة', '').error, /اكتب/);
});

test('questions can be listed by one title', () => {
  repo.createQuestion({ title: 'حيوانات', answer: 'قط', clue: 'يموء' });
  repo.createQuestion({ title: 'سيارات', answer: 'مرسيدس', clue: 'سيارة ألمانية' });
  assert.deepEqual(repo.listQuestions({ title: 'سيارات' }).map((q) => q.answer), ['مرسيدس']);
});
