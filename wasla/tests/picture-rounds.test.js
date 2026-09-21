import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { openDatabase } from '../src/db/index.js';
import {
  createPictureRounds, PICTURE_DECOYS, PICTURE_MISTAKES, PICTURE_WORDS, readRound,
} from '../src/picture-rounds.js';

const FILE = `${'a'.repeat(24)}.jpg`;
const SONY = {
  title: 'بلايستيشن',
  imageFile: FILE,
  words: 'ذراع التحكم\nأسلاك\nأقراص\nشاشة\nألعاب',
  decoys: 'ملعب\nحكم\nسلة\nمدرب\nصافرة',
};

let db;
let pictures;

beforeEach(() => {
  db = openDatabase(':memory:');
  pictures = createPictureRounds(db, { publicUrl: 'https://wasla.example' });
});

test('a round needs its name, five words that belong and five that do not', () => {
  assert.equal(readRound(SONY).errors, undefined);
  assert.match(readRound({ ...SONY, title: '  ' }).errors.join(), /اسم الصورة/);
  assert.match(readRound({ ...SONY, words: 'أسلاك\nأقراص' }).errors.join(), new RegExp(`${PICTURE_WORDS} كلمات`));
  assert.match(readRound({ ...SONY, decoys: 'ملعب' }).errors.join(), new RegExp(`${PICTURE_DECOYS} كلمات`));
});

test('a word cannot be in both lists, and must be Arabic', () => {
  assert.match(readRound({ ...SONY, decoys: 'أسلاك\nحكم\nسلة\nمدرب\nصافرة' }).errors.join(), /مرتين/);
  assert.match(readRound({ ...SONY, decoys: 'wires\nحكم\nسلة\nمدرب\nصافرة' }).errors.join(), /حروفاً عربية/);
});

test('a saved round is a draft until it is published, and needs a picture to be published', () => {
  const { id } = pictures.save(SONY);
  assert.equal(pictures.get(id).published, false);
  assert.equal(pictures.forDate('2026-09-26'), null, 'a draft is never played');

  assert.equal(pictures.setPublished(id, true).error, undefined);
  assert.equal(pictures.counts().published, 1);

  const bare = pictures.save({ ...SONY, imageFile: null, title: 'بلا صورة' });
  assert.match(pictures.setPublished(bare.id, true).error, /أضف صورة/);
});

test('the round a date plays carries ten mixed words, the five that count and its picture', () => {
  const { id } = pictures.save(SONY);
  pictures.setPublished(id, true);

  const game = pictures.forDate('2026-09-26');
  assert.equal(game.title, 'بلايستيشن');
  assert.equal(game.words.length, PICTURE_WORDS + PICTURE_DECOYS);
  assert.equal(game.answers.length, PICTURE_WORDS);
  assert.equal(game.mistakes, PICTURE_MISTAKES);
  assert.equal(game.image.url, `https://wasla.example/media/questions/${FILE}`);
  for (const answer of game.answers) assert.ok(game.words.includes(answer), `${answer} is on the board`);
  assert.deepEqual([...game.words].sort(), ['ذراع التحكم', 'أسلاك', 'أقراص', 'شاشة', 'ألعاب', 'ملعب', 'حكم', 'سلة', 'مدرب', 'صافرة'].sort());
  assert.deepEqual(pictures.forDate('2026-09-26'), game, 'the same date always plays the same round');
});

test('dates move through the published rounds, and another pick differs', () => {
  for (let i = 0; i < 4; i++) {
    const { id } = pictures.save({ ...SONY, title: `صورة ${i}` });
    pictures.setPublished(id, true);
  }
  const week = new Set(Array.from({ length: 8 }, (_, i) => pictures.forDate(`2026-09-${20 + i}`).title));
  assert.ok(week.size >= 3, 'neighbouring days are not the same round');
  const first = pictures.forDate('2026-09-26');
  assert.notEqual(pictures.forDate('2026-09-26', 1).title, first.title);
});

test('editing a round keeps its id, and a deleted one is gone', () => {
  const { id } = pictures.save(SONY);
  assert.equal(pictures.save({ ...SONY, title: 'بلايستيشن ٥' }, id).id, id);
  assert.equal(pictures.get(id).title, 'بلايستيشن ٥');
  assert.ok(pictures.remove(id));
  assert.equal(pictures.get(id), null);
  assert.match(pictures.save(SONY, 9999).errors.join(), /لا توجد صورة/);
});

test('a database from before the picture rounds still opens, and can plan one', () => {
  const again = openDatabase(':memory:');
  again.exec("INSERT INTO daily_game_days (date, kind, game) VALUES ('2026-09-26', 'picture', '{}')");
  assert.equal(again.prepare('SELECT COUNT(*) FROM daily_game_days').pluck().get(), 1);
});
