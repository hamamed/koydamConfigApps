import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openDatabase } from '../src/db/index.js';
import { BANK_SIZE, CONTENT_HEIGHT, letterBank, pictureBox, previewLevel, previewQuestion, questionLayout, stageOf, tileSize } from '../src/preview.js';
import { createRepository } from '../src/repository.js';

test('tiles follow the app: at most 62 pt, fitting 358 × 569 with 5 pt gaps', () => {
  assert.equal(CONTENT_HEIGHT, 719);
  assert.equal(tileSize(3, 4), 62);
  assert.equal(tileSize(8, 8), 40);   // (358 − 35) / 8
  assert.equal(tileSize(12, 5), 42);  // ⌊(569 − 55) / 12⌋
  assert.equal(tileSize(40, 40), 16); // never below the minimum
});

test('the stage is what the app picks: audio, emoji, picture, else text', () => {
  assert.equal(stageOf({ type: 'audio', audioFile: 'a.m4a', imageFile: 'x.jpg' }), 'audio');
  assert.equal(stageOf({ type: 'audio', audioFile: null, imageFile: 'x.jpg' }), 'picture');
  assert.equal(stageOf({ type: 'emoji', emoji: '🦁' }), 'emoji');
  assert.equal(stageOf({ type: 'emoji', emoji: ' ' }), 'text');
  assert.equal(stageOf({ type: 'text', imageFile: 'x.jpg' }), 'picture');
  assert.equal(stageOf({ type: 'text' }), 'text');
});

test('question layout matches QuestionLayout on a 390 × 844 phone', () => {
  const picture = questionLayout({ stage: 'picture', letterCount: 4, hasTitle: true });
  assert.deepEqual([picture.isCompact, picture.slotSide, picture.hasClueLine, picture.helpsHeight], [false, 50, true, 92]);
  assert.equal(picture.stage, 173);
  const text = questionLayout({ stage: 'text', letterCount: 4, hasTitle: true });
  assert.equal(text.hasClueLine, false);
  assert.equal(text.stage, 201); // (719 − 495.67) × 0.9
  assert.equal(questionLayout({ stage: 'emoji', letterCount: 8, hasTitle: false }).stage, 216); // 300 × 0.72
  // The card is wider than the square stage; a wide picture fills it (QuestionLayout.stageWidth).
  assert.equal(picture.stageWidth, 322);
  assert.equal(questionLayout({ stage: 'picture', letterCount: 8, hasTitle: false }).slotSide, 34);
});

test('the letter bank holds the answer letters plus fillers to 12, the same on every load', () => {
  const bank = letterBank([...'اسد'], 7);
  assert.equal(bank.length, BANK_SIZE);
  for (const letter of 'اسد') assert.ok(bank.includes(letter));
  assert.deepEqual(letterBank([...'اسد'], 7), bank);
  assert.equal(letterBank([...'ابتثجحخدذرزسش'], 1).length, 13);
});

test('a level preview lists placed words with their cells, banks and helps', () => {
  const repo = createRepository(openDatabase(':memory:'));
  const ids = [
    repo.createQuestion({ title: 'بلدان', answer: 'مصر', clue: 'بلد الأهرامات', imageFile: 'a'.repeat(24) + '.jpg', zoom: 2, blurred: true }),
    repo.createQuestion({ title: 'عام', answer: 'مرس', clue: 'ميناء' }),
  ].map((r) => r.question.id);
  const level = repo.createLevel();
  repo.setLevelQuestions(level.id, ids);

  const preview = previewLevel(repo.getLevel(level.id));
  assert.equal(preview.words.length, 2);
  const egypt = preview.words.find((w) => w.answer === 'مصر');
  assert.equal(egypt.stage, 'picture');
  assert.deepEqual(egypt.helps.map((h) => h.kind), ['revealLetter', 'removeLetters', 'solveWord', 'unzoomImage', 'unblurImage', 'askFriend']);
  const plain = preview.words.find((w) => w.answer === 'مرس');
  assert.deepEqual(plain.helps.map((h) => h.kind), ['revealLetter', 'removeLetters', 'solveWord', 'askFriend']);
  // The shared م belongs to both words.
  assert.equal(preview.cells.filter((c) => c.words.length === 2).length, 1);
  assert.equal(preview.cells.length, 5);
});

test('a picture is framed in its own shape, as big as the card and the stage allow', () => {
  // QuestionImageView.box in the app: the same numbers, so the preview is what the player sees.
  assert.deepEqual(pictureBox({ width: 900, height: 600 }, 300, 322), { width: 322, height: 215 });
  assert.deepEqual(pictureBox({ width: 600, height: 900 }, 300, 322), { width: 200, height: 300 });
  assert.deepEqual(pictureBox({ width: 512, height: 512 }, 300, 322), { width: 300, height: 300 });
  // A flag saved small is drawn as big as one saved large.
  assert.deepEqual(pictureBox({ width: 90, height: 60 }, 300, 322), { width: 322, height: 215 });
  // Extremes stop shrinking instead of becoming a strip.
  assert.deepEqual(pictureBox({ width: 1200, height: 200 }, 300, 322), { width: 322, height: 135 });
  assert.deepEqual(pictureBox({ width: 200, height: 1200 }, 300, 322), { width: 135, height: 300 });
  // Without a card width the picture stays inside the square stage.
  assert.deepEqual(pictureBox({ width: 900, height: 600 }, 300), { width: 300, height: 200 });
  // No picture yet, or a kind whose size cannot be read: the square the app draws meanwhile.
  assert.deepEqual(pictureBox(null, 300, 322), { width: 300, height: 300 });
});

test('a level preview carries each picture frame, and none for a text question', () => {
  const db = openDatabase(':memory:');
  const repo = createRepository(db);
  const wide = repo.createQuestion({ answer: 'امريكا', clue: '', title: 'علم', type: 'image', imageFile: 'wide.png' }).question;
  const plain = repo.createQuestion({ answer: 'اسد', clue: 'ملك الغابة', title: 'حيوان' }).question;
  const level = repo.newLevelFromQuestions([wide.id, plain.id]).level;
  const sizes = { 'wide.png': { width: 320, height: 168 } };
  const preview = previewLevel(repo.getLevel(level.id), { pictureSize: (file) => sizes[file] ?? null });
  const picture = preview.words.find((w) => w.stage === 'picture');
  assert.deepEqual(picture.picture, pictureBox(sizes['wide.png'], picture.layout.stage, picture.layout.stageWidth));
  assert.ok(picture.picture.width > picture.layout.stage, 'a wide flag uses the card, not just the square');
  assert.equal(preview.words.find((w) => w.stage === 'text').picture, null);
});

test('a picture framed a little closer offers no way to pay for opening it out', () => {
  const db = openDatabase(':memory:');
  const repo = createRepository(db);
  const framed = repo.createQuestion({
    answer: 'كونان', clue: '', title: 'شخصيات كرتونية', type: 'image', imageFile: 'a.jpg', zoom: 1.3,
  }).question;
  const closeUp = repo.createQuestion({
    answer: 'ثوم', clue: '', title: 'صورة مكبّرة', type: 'image', imageFile: 'b.jpg', zoom: 3.2,
  }).question;
  const helps = (question) => previewQuestion(question).helps.map((h) => h.kind);
  assert.ok(!helps(framed).includes('unzoomImage'), 'a 1.3× crop is framing, not a puzzle');
  assert.ok(helps(closeUp).includes('unzoomImage'), 'the close-up category keeps the help');
});
