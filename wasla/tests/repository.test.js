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
    repo.createQuestion({ title: 'عام', answer, clue: `سؤال ${answer}` }).question.id);
  const level = repo.createLevel();
  repo.setLevelQuestions(level.id, ids);
  return { level, ids };
}

test('a question is stored with its answer normalised and its title trimmed', () => {
  const { question } = repo.createQuestion({ title: ' بلدان ', answer: 'مَصْر', clue: ' بلد الأهرامات ', category: 'ignored' });

  assert.equal(question.answer, 'مصر');
  assert.equal(question.clue, 'بلد الأهرامات');
  assert.equal(question.title, 'بلدان');
  assert.equal('category' in question, false);
  assert.equal(question.zoom, 1);
});

test('a title is required, trimmed, and at most 40 characters of any script', () => {
  assert.match(repo.createQuestion({ answer: 'مصر', clue: 'x' }).error, /title/i);
  assert.match(repo.createQuestion({ title: '   ', answer: 'مصر', clue: 'x' }).error, /title/i);
  assert.match(repo.createQuestion({ title: 'ع'.repeat(41), answer: 'مصر', clue: 'x' }).error, /40/);
  assert.equal(repo.createQuestion({ title: 'ع'.repeat(40), answer: 'مصر', clue: 'x' }).error, undefined);
  assert.equal(repo.createQuestion({ title: 'Capitals 🌍', answer: 'مصر', clue: 'x' }).question.title, 'Capitals 🌍');
  assert.equal(repo.listQuestions().length, 2);
});

test('an edit keeps the title unless a new one is given, and cannot clear it', () => {
  const { id } = repo.createQuestion({ title: 'بلدان', answer: 'مصر', clue: 'x' }).question;

  assert.equal(repo.updateQuestion(id, { clue: 'y' }).question.title, 'بلدان');
  assert.equal(repo.updateQuestion(id, { title: 'عواصم' }).question.title, 'عواصم');
  assert.match(repo.updateQuestion(id, { title: '' }).error, /title/i);
});

test('a question search matches its title', () => {
  repo.createQuestion({ title: 'حيوانات', answer: 'اسد', clue: 'x' });
  repo.createQuestion({ title: 'بلدان', answer: 'مصر', clue: 'y' });

  assert.deepEqual(repo.listQuestions({ search: 'حيوان' }).map((q) => q.answer), ['اسد']);
});

test('an untitled question from before titles still loads, lays out and publishes', () => {
  const db = openDatabase(':memory:');
  const legacy = createRepository(db);
  const insert = db.prepare('INSERT INTO questions (answer, clue) VALUES (?, ?)');
  const ids = ['مصر', 'مرس'].map((answer) => Number(insert.run(answer, 'x').lastInsertRowid));
  const level = legacy.createLevel();
  legacy.setLevelQuestions(level.id, ids);

  assert.equal(legacy.getQuestion(ids[0]).title, '');
  assert.equal(legacy.setPublished(level.id, true).error, undefined);
  assert.deepEqual(legacy.publishedLevel(1).words.map((w) => w.title), ['', '']);
  // Saving it from the form needs a title now.
  assert.match(legacy.updateQuestion(ids[0], { clue: 'y' }).error, /title/i);
});

test('an invalid question is refused with a reason and nothing is stored', () => {
  assert.match(repo.createQuestion({ title: 'عام', answer: 'Paris', clue: 'x' }).error, /Arabic letters/);
  assert.match(repo.createQuestion({ title: 'عام', answer: 'مصر', clue: '' }).error, /clue/i);
  assert.match(repo.createQuestion({ title: 'عام', answer: 'مصر', clue: 'x', zoom: 9 }).error, /zoom/i);
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
  const draft = repo.createLevel();

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
  const a = repo.createQuestion({ title: 'عام', answer: 'مصر', clue: 'x' }).question.id;
  const b = repo.createQuestion({ title: 'عام', answer: 'جحخ', clue: 'y' }).question.id;
  const level = repo.createLevel();
  repo.setLevelQuestions(level.id, [a, b]);

  assert.equal(repo.getLevel(level.id).unplaced.length, 1);
  assert.match(repo.setPublished(level.id, true).error, /cross/);
});

test('a question used by a level cannot be deleted', () => {
  const { ids } = sampleLevel();

  assert.match(repo.deleteQuestion(ids[0]).error, /Level 1/);
  const unused = repo.createQuestion({ title: 'عام', answer: 'قمر', clue: 'x' }).question.id;
  assert.equal(repo.deleteQuestion(unused).error, undefined);
});

test('changing an answer re-lays the levels using it and unpublishes one that breaks', () => {
  const { level, ids } = sampleLevel();
  repo.setPublished(level.id, true);

  const result = repo.updateQuestion(ids[1], { answer: 'جحخ', clue: 'x' });

  assert.deepEqual(result.unpublished, ['Level 1']);
  assert.equal(repo.getLevel(level.id).published, false);
});

test('levels can be reordered', () => {
  const one = repo.createLevel();
  const two = repo.createLevel();

  repo.moveLevel(two.id, 'up');

  assert.deepEqual(repo.listLevels().map((l) => l.id), [two.id, one.id]);
  assert.deepEqual(repo.listLevels().map((l) => l.name), ['Level 1', 'Level 2']);
});

test('levels are named by their place in the list, with the app number beside a published one after a draft', () => {
  const draft = repo.createLevel();
  const { level } = sampleLevel();
  repo.setPublished(level.id, true);

  assert.equal(draft.name, 'Level 1');
  const listed = repo.listLevels();
  assert.deepEqual(listed.map((l) => [l.number, l.publishedNumber, l.name]), [
    [1, null, 'Level 1'],
    [2, 1, 'Level 2 (app 1)'],
  ]);
  assert.equal(repo.getLevel(level.id).name, 'Level 2 (app 1)');
  assert.equal(repo.levelByNumber(2).id, level.id);
  assert.equal(repo.levelByNumber(3), null);
  // The app gets a number-based title; the legacy column is not used.
  assert.equal(repo.publishedLevels()[0].title, 'لغز رقم 1');
});

test('a new level stores no title and goes at the end', () => {
  const db = openDatabase(':memory:');
  const fresh = createRepository(db);
  fresh.createLevel();
  const second = fresh.createLevel({ difficulty: 'hard' });

  assert.equal(second.number, 2);
  assert.equal(second.difficulty, 'hard');
  assert.equal(db.prepare('SELECT title FROM levels WHERE id = ?').get(second.id).title, '');
});

test('image zoom and focus are kept with the question', () => {
  const { question } = repo.createQuestion({ title: 'عام', answer: 'قمر', clue: 'x', imageFile: 'a.jpg', zoom: 2.5, focusX: 0.2, focusY: 0.8 });

  assert.deepEqual(
    [question.imageFile, question.zoom, question.focusX, question.focusY],
    ['a.jpg', 2.5, 0.2, 0.8],
  );
});

// ── Hamza folding ───────────────────────────────────────────────────────────

test('an answer keeps its spelling but is laid out and crossed in its played form', () => {
  // أسد and اسم only share a letter once أ is played as ا.
  const a = repo.createQuestion({ title: 'عام', answer: 'أسد', clue: 'ملك الغابة' }).question;
  const b = repo.createQuestion({ title: 'عام', answer: 'امل', clue: 'رجاء' }).question;
  const level = repo.createLevel();
  const { layout } = repo.setLevelQuestions(level.id, [a.id, b.id]);

  assert.equal(a.answer, 'أسد');
  assert.equal(a.playAnswer, 'اسد');
  assert.deepEqual(layout.unplaced, []);
  assert.equal(repo.setPublished(level.id, true).error, undefined);
});

// ── Question types ──────────────────────────────────────────────────────────

test('a question type is derived from its media when not given', () => {
  assert.equal(repo.createQuestion({ title: 'عام', answer: 'قمر', clue: 'x' }).question.type, 'text');
  assert.equal(repo.createQuestion({ title: 'عام', answer: 'قمر', clue: 'x', emoji: '🌙' }).question.type, 'emoji');
  assert.equal(repo.createQuestion({ title: 'عام', answer: 'قمر', clue: 'x', imageFile: 'a.jpg', blurred: true }).question.type, 'image');
  const audio = repo.createQuestion({ title: 'عام', answer: 'قمر', clue: 'x', audioFile: 'b.mp3', imageFile: 'a.jpg' }).question;
  assert.equal(audio.type, 'audio');
  assert.equal(audio.audioFile, 'b.mp3');
});

test('a chosen type needs the media it names', () => {
  assert.match(repo.createQuestion({ title: 'عام', answer: 'قمر', clue: 'x', type: 'audio' }).error, /audio/i);
  assert.match(repo.createQuestion({ title: 'عام', answer: 'قمر', clue: 'x', type: 'image' }).error, /picture/i);
  assert.match(repo.createQuestion({ title: 'عام', answer: 'قمر', clue: 'x', type: 'emoji' }).error, /emoji/i);
  assert.match(repo.createQuestion({ title: 'عام', answer: 'قمر', clue: 'x', type: 'video' }).error, /type/i);
  assert.match(repo.createQuestion({ title: 'عام', answer: 'قمر', clue: 'x', emoji: 'abc' }).error, /emoji/i);
  assert.equal(repo.createQuestion({ title: 'عام', answer: 'قمر', clue: 'x', type: 'text', emoji: '🌙' }).question.type, 'text');
});

test('the blur flag is kept only with a picture', () => {
  const withPicture = repo.createQuestion({ title: 'عام', answer: 'قمر', clue: 'x', imageFile: 'a.jpg', blurred: true }).question;
  const without = repo.createQuestion({ title: 'عام', answer: 'قمر', clue: 'x', blurred: true }).question;
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
  const level = repo.createLevel();
  assert.match(repo.setLevelDetails(level.id, { difficulty: 'extreme' }).error, /difficulty/i);
  assert.equal(repo.setLevelDetails(level.id, { difficulty: 'easy' }).level.difficulty, 'easy');
});

test('a level still assigned to a legacy pack row reads and publishes normally', () => {
  const db = openDatabase(':memory:');
  const legacy = createRepository(db);
  db.prepare("INSERT INTO packs (slug, title, color, icon, position) VALUES ('old', 'قديم', '#14A49E', 'star.fill', 1)").run();
  const ids = ['مصر', 'مرس'].map((answer) => legacy.createQuestion({ title: 'عام', answer, clue: 'x' }).question.id);
  const level = legacy.createLevel();
  legacy.setLevelQuestions(level.id, ids);
  db.prepare('UPDATE levels SET pack_id = 1 WHERE id = ?').run(level.id);
  legacy.setPublished(level.id, true);

  assert.deepEqual(legacy.publishedLevels().map((l) => [l.number, l.title]), [[1, 'لغز رقم 1']]);
});

// ── Difficulty ordering ─────────────────────────────────────────────────────

test('ordering by difficulty sorts all levels together by difficulty, then word count, then position', () => {
  const names = new Map();
  const make = (title, difficulty, words) => {
    const level = repo.createLevel({ difficulty });
    names.set(level.id, title);
    const ids = ['مصر', 'مرس', 'سمر', 'رسم'].slice(0, words)
      .map((answer) => repo.createQuestion({ title: 'عام', answer, clue: 'x' }).question.id);
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

  assert.deepEqual(repo.listLevels().map((l) => names.get(l.id)), [
    'easy-a', 'easy-b', 'easy-c', 'easy-big', 'medium-small', 'medium-a', 'hard',
  ]);
  assert.deepEqual(repo.listLevels().map((l) => l.position), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(moved > 0);
  assert.equal(repo.orderByDifficulty(), 0);
});

// ── One level per question ──────────────────────────────────────────────────

test('a question already in one level is not added to another', () => {
  const ids = ['مصر', 'مرس', 'سمر'].map((answer) => repo.createQuestion({ answer, title: 'بلدان', clue: 'x' }).question.id);
  const first = repo.createLevel();
  const second = repo.createLevel();
  repo.setLevelQuestions(first.id, [ids[0], ids[1]]);

  const { skipped } = repo.setLevelQuestions(second.id, [ids[1], ids[2]]);

  assert.deepEqual(skipped, [ids[1]]);
  assert.deepEqual([...repo.getLevel(second.id).words, ...repo.getLevel(second.id).unplaced].map((w) => w.id), [ids[2]]);
  // Saving the first level again with its own questions still works.
  assert.deepEqual(repo.setLevelQuestions(first.id, [ids[0], ids[1]]).skipped, []);
});

test('questions free for a level: unused ones and its own, never another level\'s', () => {
  const ids = ['مصر', 'مرس', 'سمر'].map((answer) => repo.createQuestion({ answer, title: 'بلدان', clue: 'x' }).question.id);
  const first = repo.createLevel();
  const second = repo.createLevel();
  repo.setLevelQuestions(first.id, [ids[0]]);
  repo.setLevelQuestions(second.id, [ids[1]]);

  assert.deepEqual(repo.questionsForLevel(second.id).map((q) => q.id).sort(), [ids[1], ids[2]].sort());
});

// ── Bulk actions ────────────────────────────────────────────────────────────

test('bulk delete removes questions in no level and keeps those in a level', () => {
  const { ids } = sampleLevel();
  const loose = repo.createQuestion({ title: 'عام', answer: 'قطر', clue: 'بلد' }).question.id;

  const result = repo.deleteQuestions([loose, ids[0], 999999]);

  assert.deepEqual({ deleted: result.deleted, kept: result.kept }, { deleted: 1, kept: 1 });
  assert.equal(repo.getQuestion(loose), undefined);
  assert.ok(repo.getQuestion(ids[0]));
});

test('bulk title sets one trimmed title and refuses an empty or long one', () => {
  const a = repo.createQuestion({ title: 'قديم', answer: 'قطر', clue: 'بلد' }).question.id;
  const b = repo.createQuestion({ title: 'قديم', answer: 'ليبيا', clue: 'بلد' }).question.id;

  assert.deepEqual(repo.setQuestionsTitle([a, String(b)], ' بلدان '), { updated: 2 });
  assert.equal(repo.getQuestion(a).title, 'بلدان');
  assert.match(repo.setQuestionsTitle([a], '  ').error, /title/);
  assert.match(repo.setQuestionsTitle([a], 'ع'.repeat(41)).error, /40/);
});

test('moving questions takes them out of their old level and lays out both', () => {
  const { level, ids } = sampleLevel();
  const other = repo.createLevel();

  const result = repo.moveQuestionsToLevel(ids.slice(0, 3), other.id);

  assert.equal(result.moved, 3);
  assert.equal(repo.getLevel(other.id).words.length + repo.getLevel(other.id).unplaced.length, 3);
  assert.equal(repo.getLevel(level.id).words.length + repo.getLevel(level.id).unplaced.length, 2);
  assert.match(repo.moveQuestionsToLevel(ids, 424242).error, /level/);
});

test('moving unpublishes a published level left with too few words, and says so', () => {
  const { level, ids } = sampleLevel();
  assert.deepEqual(repo.setPublished(level.id, true), {});
  const other = repo.createLevel();

  const result = repo.moveQuestionsToLevel(ids.slice(0, 4), other.id);

  assert.deepEqual(result.unpublished, [repo.getLevel(level.id).name]);
  assert.equal(repo.getLevel(level.id).published, false);
});

test('a new level can be made from selected questions, and questions can leave every level', () => {
  const { level, ids } = sampleLevel();

  const made = repo.newLevelFromQuestions(ids.slice(0, 2));
  assert.equal(made.moved, 2);
  assert.notEqual(made.level.id, level.id);

  assert.deepEqual(repo.removeQuestionsFromLevels(ids).removed, 5);
  assert.equal(repo.levelsUsing(ids[0]).length, 0);
  assert.match(repo.newLevelFromQuestions([]).error, /Select/);
});

test('a two-word answer keeps its space to show and is played without it', () => {
  const { question } = repo.createQuestion({ title: 'أدب وشعراء', answer: ' نجيب  محفوظ ', clue: 'صاحب الثلاثية' });
  const other = repo.createQuestion({ title: 'أدب وشعراء', answer: 'بيت', clue: 'منزل' }).question;
  const level = repo.createLevel();
  repo.setLevelQuestions(level.id, [question.id, other.id]);

  assert.equal(question.answer, 'نجيب محفوظ');
  assert.equal(question.playAnswer, 'نجيبمحفوظ');
  const words = [...repo.getLevel(level.id).words, ...repo.getLevel(level.id).unplaced];
  assert.ok(words.some((w) => w.playAnswer === 'نجيبمحفوظ'));
});

test('a picture keeps its credit, and only a real web address is accepted', () => {
  const { question } = repo.createQuestion({
    title: 'من هذا اللاعب؟', answer: 'ميسي', clue: '', type: 'image', imageFile: 'a.jpg',
    imageAuthor: ' Tasnim News Agency ', imageLicence: 'CC BY 4.0', imageSource: 'https://commons.wikimedia.org/wiki/File:A.jpg',
  });
  assert.equal(question.imageAuthor, 'Tasnim News Agency');
  assert.equal(question.imageLicence, 'CC BY 4.0');
  assert.deepEqual(repo.credited().map((q) => q.answer), ['ميسي']);
  assert.match(repo.createQuestion({ title: 'ت', answer: 'زيدان', clue: '', type: 'image', imageFile: 'b.jpg', imageSource: 'ftp://x' }).error, /web address/);

  // A question with no picture keeps no credit.
  const text = repo.createQuestion({ title: 'ت', answer: 'كرة', clue: 'يلعب بها', imageAuthor: 'someone' }).question;
  assert.equal(text.imageAuthor, '');
  assert.equal(repo.credited().length, 1);
});

test('a question keeps its difficulty, and only easy, medium or hard', () => {
  const { question } = repo.createQuestion({ title: 'معلومات عامة', answer: 'باريس', clue: 'ما عاصمة فرنسا؟', difficulty: 'easy' });
  assert.equal(question.difficulty, 'easy');
  assert.equal(repo.updateQuestion(question.id, { difficulty: '' }).question.difficulty, '');
  assert.match(repo.createQuestion({ title: 'ت', answer: 'روما', clue: 'x', difficulty: 'impossible' }).error, /easy, medium, hard/);
});

test('a picture question can wait for its picture, and its level cannot be published until it has one', () => {
  const waiting = repo.createQuestion({ title: 'شخصيات كرتونية', answer: 'ماجد', clue: '', type: 'image', awaitingPicture: true, difficulty: 'easy' });
  assert.equal(waiting.error, undefined);
  assert.equal(waiting.question.type, 'image');
  assert.equal(waiting.question.needsPicture, true);
  // Without asking, a picture question still needs its picture.
  assert.match(repo.createQuestion({ title: 'ت', answer: 'سالي', clue: '', type: 'image' }).error, /picture/i);

  // Editing the title or difficulty keeps it waiting.
  assert.equal(repo.updateQuestion(waiting.question.id, { difficulty: 'medium' }).question.needsPicture, true);

  const other = repo.createQuestion({ title: 'ت', answer: 'مجد', clue: 'عز وشرف' }).question;
  const level = repo.createLevel();
  repo.setLevelQuestions(level.id, [waiting.question.id, other.id]);
  assert.match(repo.setPublished(level.id, true).error ?? '', /Add the picture first: ماجد/);

  const pictured = repo.updateQuestion(waiting.question.id, { imageFile: 'majed.jpg', type: 'image' }).question;
  assert.equal(pictured.needsPicture, false);
});

test('levels: several can be published, re-graded and deleted at once', () => {
  const repo = createRepository(openDatabase(':memory:'));
  const make = (answers) => {
    const ids = answers.map((answer) => repo.createQuestion({ answer, clue: 'سؤال', title: 'عام' }).question.id);
    return repo.newLevelFromQuestions(ids).level;
  };
  const first = make(['كبير', 'بعيد', 'الرباط']);
  const second = make(['سعيد', 'كريم', 'سمير']);
  const empty = repo.createLevel();

  const published = repo.setLevelsPublished([first.id, second.id, empty.id], true);
  assert.equal(published.changed.length, 2, 'the two laid-out levels go live');
  assert.equal(published.problems.length, 1, 'the empty one says why it cannot');
  assert.match(published.problems[0], /at least 2 words/);
  assert.ok(repo.getLevel(first.id).published);

  assert.deepEqual(repo.setLevelsDifficulty([first.id, second.id], 'hard'), { changed: 2 });
  assert.equal(repo.getLevel(second.id).difficulty, 'hard');
  assert.match(repo.setLevelsDifficulty([first.id], 'impossible').error, /difficulty is one of/);

  const off = repo.setLevelsPublished([first.id, second.id], false);
  assert.equal(off.changed.length, 2);
  assert.equal(repo.getLevel(first.id).published, false);

  assert.deepEqual(repo.deleteLevels([first.id, empty.id]), { deleted: 2 });
  assert.equal(repo.listLevels().length, 1);
  assert.equal(repo.listLevels()[0].number, 1, 'the numbers close up behind a deleted level');
  // The questions of a deleted level are free again, not lost.
  assert.equal(repo.listQuestions({ unused: true }).length, 3);
  assert.match(repo.deleteLevels([]).error, /at least one level/);
});
