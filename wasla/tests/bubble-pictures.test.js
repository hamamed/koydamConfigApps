import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { createBubblePictures, MAX_ROUND_WORDS, MIN_ROUND_WORDS, readRound } from '../src/bubble-pictures.js';
import { buildPictureBubbles } from '../src/daily-games.js';
import { openDatabase } from '../src/db/index.js';

const FILE = `${'a'.repeat(24)}.jpg`;
const SONY = { title: 'بلايستيشن', imageFile: FILE, words: 'ألعاب\nذراع\nسوني\nأسلاك\nأقراص' };

let db;
let pictures;

beforeEach(() => {
  db = openDatabase(':memory:');
  pictures = createBubblePictures(db, { publicUrl: 'https://wasla.example' });
});

test('a round is a name, a picture and four to eight words that belong to it', () => {
  assert.equal(readRound(SONY).errors, undefined);
  assert.match(readRound({ ...SONY, title: ' ' }).errors.join(), /اسم الصورة/);
  assert.match(readRound({ ...SONY, words: 'ألعاب\nذراع' }).errors.join(), new RegExp(`${MIN_ROUND_WORDS} إلى ${MAX_ROUND_WORDS}`));
  assert.match(readRound({ ...SONY, words: 'ألعاب\nذراع\nسوني\nيد' }).errors.join(), /«يد» من 4 إلى 10 حروف/);
  assert.match(readRound({ ...SONY, words: 'ألعاب\nذراع\nسوني\ngames' }).errors.join(), /حروفاً عربية/);
  assert.match(readRound({ ...SONY, words: 'ألعاب\nذراع\nسوني\nألعاب' }).errors.join(), /مرتين/);
});

test('a round is a draft until it is published, and needs its picture', () => {
  const { id } = pictures.save(SONY);
  assert.equal(pictures.forDate('2026-09-26'), null, 'a draft is never played');
  assert.equal(pictures.setPublished(id, true).error, undefined);
  assert.equal(pictures.forDate('2026-09-26').title, 'بلايستيشن');

  const bare = pictures.save({ ...SONY, imageFile: null, title: 'بلا صورة' });
  assert.match(pictures.setPublished(bare.id, true).error, /أضف صورة/);
});

test('the game cuts the round into pieces, and every piece is on the board', () => {
  const { id } = pictures.save(SONY);
  pictures.setPublished(id, true);

  const game = buildPictureBubbles(pictures.forDate('2026-09-26'), 7);
  assert.equal(game.theme, 'بلايستيشن');
  assert.equal(game.image.url, `https://wasla.example/media/questions/${FILE}`);
  assert.equal(game.words.length, 5);
  assert.equal(new Set(game.words.map((w) => w.id)).size, 5, 'every word has its own id');
  for (const word of game.words) {
    assert.equal(word.parts.join(''), word.word, `${word.display} is its own pieces`);
    assert.ok(word.parts.every((part) => [...part].length >= 2), 'never a piece of one letter');
  }
  assert.deepEqual([...game.bubbles].sort(), game.words.flatMap((w) => w.parts).sort());
  assert.deepEqual(buildPictureBubbles(pictures.forDate('2026-09-26'), 7), game, 'the same date plays the same board');
});

test('with no picture published the game still comes from the bank', () => {
  assert.equal(buildPictureBubbles(null, 1), null, 'nothing to build without a round');
});

test('dates move through the published pictures, and another pick differs', () => {
  for (const name of ['بلايستيشن', 'مطبخ', 'مدرسة', 'مطار']) {
    const { id } = pictures.save({ ...SONY, title: name });
    pictures.setPublished(id, true);
  }
  const week = new Set(Array.from({ length: 8 }, (_, i) => pictures.forDate(`2026-09-${20 + i}`).title));
  assert.ok(week.size >= 3, 'neighbouring days are not the same picture');
  assert.notEqual(pictures.forDate('2026-09-26', 1).title, pictures.forDate('2026-09-26').title);
});
