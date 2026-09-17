import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openDatabase } from '../src/db/index.js';
import { BANK_SIZE, CONTENT_HEIGHT, letterBank, previewLevel, questionLayout, stageOf, tileSize } from '../src/preview.js';
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
  assert.equal(questionLayout({ stage: 'emoji', letterCount: 8, hasTitle: false }).stage, 194); // 270 × 0.72
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
