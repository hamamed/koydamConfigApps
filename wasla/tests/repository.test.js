import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { openDatabase } from '../src/db/index.js';
import { createRepository } from '../src/repository.js';

let repo;

beforeEach(() => {
  repo = createRepository(openDatabase(':memory:'));
});

function sampleLevel() {
  const ids = ['المغرب', 'مصر', 'باريس', 'تونس', 'عمان'].map((answer) =>
    repo.createQuestion({ answer, clue: `سؤال ${answer}` }).question.id);
  const level = repo.createLevel('بلدان وعواصم');
  repo.setLevelQuestions(level.id, ids);
  return { level, ids };
}

test('a question is stored with its answer normalised', () => {
  const { question } = repo.createQuestion({ answer: 'مَصْر', clue: ' بلد الأهرامات ', category: 'بلدان' });

  assert.equal(question.answer, 'مصر');
  assert.equal(question.clue, 'بلد الأهرامات');
  assert.equal(question.zoom, 1);
});

test('an invalid question is refused with a reason and nothing is stored', () => {
  assert.match(repo.createQuestion({ answer: 'Paris', clue: 'x' }).error, /Arabic letters/);
  assert.match(repo.createQuestion({ answer: 'مصر', clue: '' }).error, /clue/i);
  assert.match(repo.createQuestion({ answer: 'مصر', clue: 'x', zoom: 9 }).error, /zoom/i);
  assert.equal(repo.listQuestions().length, 0);
});

test('choosing questions for a level lays out the grid', () => {
  const { level } = sampleLevel();
  const saved = repo.getLevel(level.id);

  assert.equal(saved.words.length, 5);
  assert.ok(saved.words.every((w) => w.direction === 'across' || w.direction === 'down'));
  assert.ok(saved.rows > 0 && saved.cols > 0);
  assert.equal(saved.unplaced.length, 0);
});

test('only published, fully placed levels reach the app, numbered in order', () => {
  const { level } = sampleLevel();
  const draft = repo.createLevel('مسودة');

  assert.deepEqual(repo.publishedLevels(), []);
  assert.equal(repo.setPublished(level.id, true).error, undefined);
  assert.match(repo.setPublished(draft.id, true).error, /at least 2/);

  const levels = repo.publishedLevels();
  assert.equal(levels.length, 1);
  assert.equal(levels[0].number, 1);
  assert.equal(levels[0].wordCount, 5);

  const full = repo.publishedLevel(1);
  assert.equal(full.words.length, 5);
  assert.equal(repo.publishedLevel(2), null);
});

test('a level with a word that cannot cross the others cannot be published', () => {
  const a = repo.createQuestion({ answer: 'مصر', clue: 'x' }).question.id;
  const b = repo.createQuestion({ answer: 'جحخ', clue: 'y' }).question.id;
  const level = repo.createLevel('x');
  repo.setLevelQuestions(level.id, [a, b]);

  assert.equal(repo.getLevel(level.id).unplaced.length, 1);
  assert.match(repo.setPublished(level.id, true).error, /cross/);
});

test('a question used by a level cannot be deleted', () => {
  const { ids } = sampleLevel();

  assert.match(repo.deleteQuestion(ids[0]).error, /بلدان وعواصم/);
  const unused = repo.createQuestion({ answer: 'قمر', clue: 'x' }).question.id;
  assert.equal(repo.deleteQuestion(unused).error, undefined);
});

test('changing an answer re-lays the levels using it and unpublishes one that breaks', () => {
  const { level, ids } = sampleLevel();
  repo.setPublished(level.id, true);

  const result = repo.updateQuestion(ids[1], { answer: 'جحخ', clue: 'x' });

  assert.deepEqual(result.unpublished, ['بلدان وعواصم']);
  assert.equal(repo.getLevel(level.id).published, false);
});

test('levels can be reordered', () => {
  const one = repo.createLevel('one');
  const two = repo.createLevel('two');

  repo.moveLevel(two.id, 'up');

  assert.deepEqual(repo.listLevels().map((l) => l.title), ['two', 'one']);
});

test('image zoom and focus are kept with the question', () => {
  const { question } = repo.createQuestion({ answer: 'قمر', clue: 'x', imageFile: 'a.jpg', zoom: 2.5, focusX: 0.2, focusY: 0.8 });

  assert.deepEqual(
    [question.imageFile, question.zoom, question.focusX, question.focusY],
    ['a.jpg', 2.5, 0.2, 0.8],
  );
});

// ── Hamza folding ───────────────────────────────────────────────────────────

test('an answer keeps its spelling but is laid out and crossed in its played form', () => {
  // أسد and اسم only share a letter once أ is played as ا.
  const a = repo.createQuestion({ answer: 'أسد', clue: 'ملك الغابة' }).question;
  const b = repo.createQuestion({ answer: 'امل', clue: 'رجاء' }).question;
  const level = repo.createLevel('همزة');
  const { layout } = repo.setLevelQuestions(level.id, [a.id, b.id]);

  assert.equal(a.answer, 'أسد');
  assert.equal(a.playAnswer, 'اسد');
  assert.deepEqual(layout.unplaced, []);
  assert.equal(repo.setPublished(level.id, true).error, undefined);
});

// ── Question types ──────────────────────────────────────────────────────────

test('a question type is derived from its media when not given', () => {
  assert.equal(repo.createQuestion({ answer: 'قمر', clue: 'x' }).question.type, 'text');
  assert.equal(repo.createQuestion({ answer: 'قمر', clue: 'x', emoji: '🌙' }).question.type, 'emoji');
  assert.equal(repo.createQuestion({ answer: 'قمر', clue: 'x', imageFile: 'a.jpg', blurred: true }).question.type, 'image');
  const audio = repo.createQuestion({ answer: 'قمر', clue: 'x', audioFile: 'b.mp3', imageFile: 'a.jpg' }).question;
  assert.equal(audio.type, 'audio');
  assert.equal(audio.audioFile, 'b.mp3');
});

test('a chosen type needs the media it names', () => {
  assert.match(repo.createQuestion({ answer: 'قمر', clue: 'x', type: 'audio' }).error, /audio/i);
  assert.match(repo.createQuestion({ answer: 'قمر', clue: 'x', type: 'image' }).error, /picture/i);
  assert.match(repo.createQuestion({ answer: 'قمر', clue: 'x', type: 'emoji' }).error, /emoji/i);
  assert.match(repo.createQuestion({ answer: 'قمر', clue: 'x', type: 'video' }).error, /type/i);
  assert.match(repo.createQuestion({ answer: 'قمر', clue: 'x', emoji: 'abc' }).error, /emoji/i);
  assert.equal(repo.createQuestion({ answer: 'قمر', clue: 'x', type: 'text', emoji: '🌙' }).question.type, 'text');
});

test('the blur flag is kept only with a picture', () => {
  const withPicture = repo.createQuestion({ answer: 'قمر', clue: 'x', imageFile: 'a.jpg', blurred: true }).question;
  const without = repo.createQuestion({ answer: 'قمر', clue: 'x', blurred: true }).question;
  assert.equal(withPicture.blurred, true);
  assert.equal(without.blurred, false);
});

// ── Level details ───────────────────────────────────────────────────────────

test('published levels are one numbered run carrying their difficulty and no pack', () => {
  const a = sampleLevel().level;
  const b = sampleLevel().level;
  repo.setLevelDetails(a.id, { difficulty: 'hard' });
  [a, b].forEach((l) => repo.setPublished(l.id, true));

  const levels = repo.publishedLevels();
  assert.deepEqual(levels.map((l) => [l.number, l.difficulty]), [[1, 'hard'], [2, 'medium']]);
  for (const level of levels) {
    assert.equal('pack' in level, false);
    assert.equal('packPosition' in level, false);
  }
  assert.equal('pack' in repo.publishedLevel(1), false);
});

test('a level refuses an unknown difficulty', () => {
  const level = repo.createLevel('x');
  assert.match(repo.setLevelDetails(level.id, { difficulty: 'extreme' }).error, /difficulty/i);
  assert.equal(repo.setLevelDetails(level.id, { difficulty: 'easy' }).level.difficulty, 'easy');
});

test('a level still assigned to a legacy pack row reads and publishes normally', () => {
  const db = openDatabase(':memory:');
  const legacy = createRepository(db);
  db.prepare("INSERT INTO packs (slug, title, color, icon, position) VALUES ('old', 'قديم', '#14A49E', 'star.fill', 1)").run();
  const ids = ['مصر', 'مرس'].map((answer) => legacy.createQuestion({ answer, clue: 'x' }).question.id);
  const level = legacy.createLevel('x');
  legacy.setLevelQuestions(level.id, ids);
  db.prepare('UPDATE levels SET pack_id = 1 WHERE id = ?').run(level.id);
  legacy.setPublished(level.id, true);

  assert.deepEqual(legacy.publishedLevels().map((l) => [l.number, l.title]), [[1, 'x']]);
});

// ── Difficulty ordering ─────────────────────────────────────────────────────

test('ordering by difficulty sorts all levels together by difficulty, then word count, then position', () => {
  const make = (title, difficulty, words) => {
    const level = repo.createLevel(title, { difficulty });
    const ids = ['مصر', 'مرس', 'سمر', 'رسم'].slice(0, words)
      .map((answer) => repo.createQuestion({ answer, clue: 'x' }).question.id);
    repo.setLevelQuestions(level.id, ids);
    return level;
  };
  make('hard', 'hard', 2);
  make('medium-a', 'medium', 2);
  make('easy-big', 'easy', 3);
  make('easy-a', 'easy', 2);
  make('easy-b', 'easy', 2);
  make('medium-small', 'medium', 1);
  make('easy-c', 'easy', 2);

  const moved = repo.orderByDifficulty();

  assert.deepEqual(repo.listLevels().map((l) => l.title), [
    'easy-a', 'easy-b', 'easy-c', 'easy-big', 'medium-small', 'medium-a', 'hard',
  ]);
  assert.deepEqual(repo.listLevels().map((l) => l.position), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(moved > 0);
  assert.equal(repo.orderByDifficulty(), 0);
});
