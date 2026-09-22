import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  createBubblePictures, cuttable, MAX_CATEGORY, MAX_ROUND_WORDS, MIN_ROUND_WORDS, readRound,
} from '../src/bubble-pictures.js';
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
  assert.match(readRound({ ...SONY, words: 'ألعاب\nذراع\nسوني\nيد' }).errors.join(), /«يد» من 3 إلى 10 حروف/);
  assert.ok(!readRound({ ...SONY, words: 'ألعاب\nذراع\nسوني\nسلك' }).errors,
    'a three-letter word is kept for وصّل الحروف, which spells it letter by letter');
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

test('a round carries the category it is filed under', () => {
  const { round } = readRound({ title: 'الرمان', category: ' فواكه وخضار ', words: 'الفاكهة\nالحبات\nالعصير\nالقشرة' });
  assert.equal(round.category, 'فواكه وخضار', 'trimmed, and kept with the round');

  const { errors } = readRound({ title: 'الرمان', category: 'ط'.repeat(MAX_CATEGORY + 1), words: 'الفاكهة\nالحبات\nالعصير\nالقشرة' });
  assert.ok(errors.some((problem) => problem.includes('التصنيف')));

  assert.equal(readRound({ title: 'الرمان', words: 'الفاكهة\nالحبات\nالعصير\nالقشرة' }).round.category, '',
    'a round with no category is filed under none');
});

test('the categories say what is in each one', () => {
  const db = openDatabase(':memory:');
  const pictures = createBubblePictures(db);
  pictures.save({ title: 'الرمان', category: 'فواكه وخضار', words: 'الفاكهة\nالحبات\nالعصير\nالقشرة', imageFile: 'a.png' });
  pictures.save({ title: 'التين', category: 'فواكه وخضار', words: 'الفاكهة\nالشجرة\nالحلاوة\nالمربى', imageFile: 'b.png' });
  const { id } = pictures.save({ title: 'الأسد', category: 'حيوانات', words: 'الزئير\nالغابة\nالفريسة\nالشجاعة', imageFile: 'c.png' });
  pictures.setPublished(id, true);

  assert.deepEqual(pictures.categories(), [
    { name: 'حيوانات', total: 1, published: 1 },
    { name: 'فواكه وخضار', total: 2, published: 0 },
  ]);
  assert.equal(pictures.all().find((round) => round.title === 'التين').category, 'فواكه وخضار');
});

test('فقاعات الكلمات plays only the words its pieces can hide', () => {
  const round = {
    id: 3,
    title: 'الشمس',
    words: ['ضوء', 'صيف', 'حرارة', 'أشعة', 'شروق', 'نهار'],
    image: { url: 'https://example.test/sun.png', zoom: 1, focusX: 0.5, focusY: 0.5 },
  };
  const game = buildPictureBubbles(round, 5);
  assert.deepEqual(game.words.map((w) => w.display).sort(), ['أشعة', 'حرارة', 'شروق', 'نهار'].sort(),
    'the three-letter words are left to وصّل الحروف');
  assert.ok(game.words.every((word) => word.parts.length >= 2), 'no word comes back whole');

  assert.equal(buildPictureBubbles({ ...round, words: ['ضوء', 'صيف', 'نار', 'شمس', 'حر'] }, 5), null,
    'too few words long enough to cut: the day takes another picture');
});

test('a date takes a picture فقاعات can cut, and وصّل الحروف takes any of them', () => {
  const short = pictures.save({ title: 'الشمس', words: 'ضوء\nصيف\nحر\nنار\nشمس', imageFile: FILE });
  pictures.setPublished(short.id, true);
  assert.ok(!cuttable({ words: ['ضوء', 'صيف', 'حر', 'نار', 'شمس'] }, 4), 'nothing long enough to cut');
  assert.ok(cuttable({ words: ['حرارة', 'أشعة', 'شروق', 'نهار'] }, 4));

  const long = pictures.save({ title: 'المطر', words: 'شتاء\nغيوم\nمظلة\nبرودة', imageFile: FILE });
  pictures.setPublished(long.id, true);
  for (const date of ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23']) {
    assert.equal(pictures.forDate(date, 0, { cutAt: 4 }).title, 'المطر', 'every day takes the one it can play');
    assert.ok(['الشمس', 'المطر'].includes(pictures.forDate(date).title), 'وصّل الحروف takes either');
  }
});
