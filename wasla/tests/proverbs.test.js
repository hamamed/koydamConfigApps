import assert from 'node:assert/strict';
import { test } from 'node:test';

import { letters } from '../src/arabic.js';
import { parseRiddles } from '../src/lab.js';
import { buildProverb, PROVERB_TILES, proverbForDate } from '../src/proverbs.js';

const LIST = `
أطلب العلم ــــ في الصين | ولو | حتى، وإن، ثم | مثل سائر | 😑📚🤲
الصبر مفتاح ــــ | الفرج | الرزق، النجاح، القلوب | مثل سائر
من جدّ ــــ | وجد | صبر، سعى، ربح | مثل سائر | 💪🏆
`;

const riddles = () => parseRiddles(LIST).riddles;

test('a line may end with an emoji clue, and one without still parses', () => {
  const { riddles: list, problems } = parseRiddles(LIST);
  assert.deepEqual(problems, []);
  assert.equal(list[0].emoji, '😑📚🤲');
  assert.equal(list[1].emoji, '');
  assert.match(parseRiddles('نص | جواب | أ، ب، ج').problems[0].reason, /أربعة أجزاء/);
});

test('the board is the proverb\'s own letters, each knowing its word', () => {
  const game = buildProverb(riddles()[0], 5);
  assert.deepEqual(game.words.map((w) => w.text), ['أطلب', 'العلم', 'ولو', 'في', 'الصين']);
  assert.deepEqual(game.words.map((w) => w.hidden), [false, false, true, false, false]);
  assert.equal(game.hidden, 2, 'the gap was the third word');
  assert.equal(game.answer, 'ولو');
  assert.equal(game.emoji, '😑📚🤲');
  assert.equal(game.letters.length, PROVERB_TILES);

  // Every letter of the missing word is on the board, under its own number.
  const own = game.letters.filter((tile) => tile.group === game.hidden).map((tile) => tile.letter);
  assert.deepEqual([...own].sort(), letters(game.answer).sort());
  // And every tile belongs to a word of the proverb.
  assert.ok(game.letters.every((tile) => tile.group >= 0 && tile.group < game.words.length));
});

test('the same date always plays the same round, and another pick differs', () => {
  const first = proverbForDate(riddles(), '2026-09-23');
  assert.deepEqual(proverbForDate(riddles(), '2026-09-23'), first);
  const again = proverbForDate(riddles(), '2026-09-23', { nonce: 1 });
  assert.notEqual(again.answer, first.answer);
});

test('dates move through the list, and a bad date or an empty list gives nothing', () => {
  const week = new Set(Array.from({ length: 6 }, (_, i) => proverbForDate(riddles(), `2026-09-2${i + 1}`).answer));
  assert.ok(week.size >= 2, 'neighbouring days are not the same proverb');
  assert.equal(proverbForDate(riddles(), 'nonsense'), null);
  assert.equal(proverbForDate([], '2026-09-23'), null);
});

test('a riddle whose answer is not two Arabic letters or more is refused', () => {
  assert.equal(buildProverb({ before: 'نص', after: '', answer: 'a' }, 1), null);
  assert.equal(buildProverb({ before: 'نص', after: '', answer: 'و' }, 1), null);
  assert.equal(buildProverb(null, 1), null);
});
