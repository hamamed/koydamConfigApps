import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { openDatabase } from '../src/db/index.js';
import { createLab, parseRiddles, parseRoots } from '../src/lab.js';
import { DEFAULT_RIDDLES, DEFAULT_ROOTS } from '../src/lab-content.js';

let db;
let lab;

beforeEach(() => {
  db = openDatabase(':memory:');
  lab = createLab(db);
});

test('the built-in lists are the ones the app shipped with', () => {
  const content = lab.content();
  assert.equal(content.roots.length, 10);
  assert.equal(content.riddles.length, 20);
  assert.deepEqual(content.roots[0], { root: 'كتب', words: ['كتب', 'كتاب', 'كاتب', 'كتابة', 'مكتب', 'مكتبة', 'مكتوب', 'كتيبة', 'مكاتبة'] });
  assert.deepEqual(parseRoots(DEFAULT_ROOTS).problems, []);
  assert.deepEqual(parseRiddles(DEFAULT_RIDDLES).problems, []);
});

test('a riddle keeps what comes after the gap, and a line without one puts it at the end', () => {
  const { riddles } = parseRiddles([
    'وطني لو شُغلتُ بالخلد ــــ — نازعتني إليه في الخلد نفسي | عنه | فيه، دونه، عندي | أحمد شوقي',
    'الصبر مفتاح ــــ | الفرج | الرزق، النجاح، القلوب | مثل سائر',
    'من جدّ | وجد | صبر، سعى، ربح | مثل سائر',
  ].join('\n'));
  assert.equal(riddles[0].before, 'وطني لو شُغلتُ بالخلد');
  assert.equal(riddles[0].after, '— نازعتني إليه في الخلد نفسي');
  assert.equal(riddles[1].after, '');
  assert.equal(riddles[2].before, 'من جدّ', 'a line with no gap mark reads as a gap at the end');
});

test('a root line is checked: three letters, enough words, Arabic, and no repeat', () => {
  const { roots, problems } = parseRoots([
    'كتب: كتب كتاب كاتب',
    'كت: كتب كتاب كاتب',
    'درس: درس',
    'كتب: كتب كتاب مكتبة',
    'لعب: لعب لعبة play',
  ].join('\n'));
  assert.equal(roots.length, 1);
  assert.deepEqual(problems.map((p) => p.line), [2, 3, 4, 5]);
  assert.match(problems[0].reason, /ثلاثة حروف/);
  assert.match(problems[2].reason, /مكرر/);
});

test('a riddle line needs four parts and exactly three decoys', () => {
  const { riddles, problems } = parseRiddles([
    'الصبر مفتاح ــــ | الفرج | الرزق، النجاح، القلوب | مثل سائر',
    'الصبر مفتاح ــــ | الفرج | الرزق، النجاح | مثل سائر',
    'ناقص | الجواب',
    'الجواب مكرر ــــ | الفرج | الفرج، النجاح، القلوب | مثل سائر',
  ].join('\n'));
  assert.equal(riddles.length, 1);
  assert.deepEqual(problems.map((p) => p.line), [2, 3, 4]);
  assert.match(problems[2].reason, /مكرر/);
});

test('a list is saved whole or not at all, and can go back to the built-in one', () => {
  const good = 'قرأ: قرأ قراءة قارئ مقروء';
  assert.deepEqual(lab.saveList('roots', good), { count: 1 });
  assert.equal(lab.content().roots.length, 1);
  assert.equal(lab.lists().find((l) => l.name === 'roots').edited, true);

  const refused = lab.saveList('roots', 'كت: كلمة');
  assert.ok(refused.error, 'a broken line is refused');
  assert.equal(lab.content().roots.length, 1, 'and nothing was overwritten');

  assert.equal(lab.saveList('roots', '').error, 'تحتاج القائمة مدخلاً واحداً على الأقل.');
  assert.equal(lab.saveList('nope', good).error, 'قائمة غير معروفة.');

  assert.equal(lab.resetList('roots'), true);
  assert.equal(lab.content().roots.length, 10, 'the built-in list is back');
  assert.equal(lab.resetList('roots'), false);
});

test('comments and blank lines are skipped', () => {
  const { roots, problems } = parseRoots('# جذور\n\nكتب: كتب كتاب كاتب\n');
  assert.equal(roots.length, 1);
  assert.deepEqual(problems, []);
});
