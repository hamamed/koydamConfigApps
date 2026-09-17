import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  composeDay, CUSTOM_WORD_ID_BASE, previewOf, readCustomWords, readSeed, readSize, readThemeName,
} from '../src/wordsearch-editor.js';

const COLOURS = ['أحمر', 'أزرق', 'أخضر', 'أصفر', 'بنفسجي', 'برتقالي'];

test('typed words are stripped of harakat and folded for play, like answers', () => {
  const { words, errors } = readCustomWords(['  أَحْمَر ', '', 'أزرق', 'أخضر', 'أصفر', 'بنفسجي', 'برتقالي'].join('\r\n'));
  assert.deepEqual(errors, []);
  assert.deepEqual(words[0], { id: null, word: 'احمر', display: 'أحمر' });
  assert.equal(words.length, 6);
});

test('typed words must be Arabic, 3–8 letters, once each, and not readable inside another', () => {
  const { words, errors } = readCustomWords(['red', 'دب', 'برتقاليات', 'أسد', 'اسد', 'نمر', 'نمرة', 'رمن'].join('\n'));
  assert.deepEqual(words.map((w) => w.word), ['اسد', 'نمرة']);
  assert.equal(errors.length, 6);
  assert.match(errors[0], /Arabic letters/);
  assert.match(errors[1], /2 letters/);
  assert.match(errors[2], /9 letters/);
  assert.match(errors[3], /twice/);
  assert.ok(errors.some((e) => /“نمر” can be read inside “نمرة”/.test(e)));
  assert.ok(errors.some((e) => /“رمن” can be read inside/.test(e)));
});

test('a theme name is 1–40 characters; size is 7–10; a seed is a positive whole number', () => {
  assert.deepEqual(readThemeName('  ألوان   زاهية '), { theme: 'ألوان زاهية' });
  assert.ok(readThemeName(' ').error);
  assert.ok(readThemeName('ا'.repeat(41)).error);
  assert.deepEqual([readSize('7'), readSize('10'), readSize('6'), readSize('8.5')], [7, 10, null, null]);
  assert.deepEqual([readSeed('42'), readSeed('0'), readSeed('abc')], [42, null, null]);
});

test('typed words get ids far above question ids, and the same inputs give the same board', () => {
  const { words } = readCustomWords(COLOURS.join('\n'));
  const first = composeDay({ theme: 'ألوان', words, size: 8, seed: 99 });
  assert.equal(first.canSave, true);
  assert.deepEqual(first.dropped, []);
  assert.deepEqual(first.board.words.map((w) => w.id).sort((a, b) => a - b), COLOURS.map((_, i) => CUSTOM_WORD_ID_BASE + i + 1));
  assert.deepEqual(Object.keys(first.board), ['theme', 'size', 'rows', 'words']);
  assert.deepEqual(composeDay({ theme: 'ألوان', words, size: 8, seed: 99 }), first);
  assert.notDeepEqual(composeDay({ theme: 'ألوان', words, size: 8, seed: 100 }).board.rows, first.board.rows);

  const themed = composeDay({ theme: 'x', words: words.map((w, i) => ({ ...w, id: i + 1 })), size: 8, seed: 99 });
  assert.deepEqual(themed.board.words.map((w) => w.id).sort(), [1, 2, 3, 4, 5, 6]);
});

test('a word that cannot fit blocks saving and says why', () => {
  const { words } = readCustomWords([...COLOURS, 'برتقالية'].join('\n'));
  const small = composeDay({ theme: 'ألوان', words, size: 7, seed: 5 });
  assert.equal(small.canSave, false);
  assert.deepEqual(small.dropped.map((d) => [d.display, d.reason]), [['برتقالية', 'too-long']]);
  assert.match(small.dropped[0].message, /bigger size/);
  assert.equal(composeDay({ theme: 'ألوان', words, size: 10, seed: 5 }).canSave, true);
});

test('too few or too many words, no theme or a bad size cannot be saved', () => {
  const { words } = readCustomWords(COLOURS.join('\n'));
  assert.match(composeDay({ theme: 'ألوان', words: words.slice(0, 5), size: 8, seed: 1 }).problems.join(), /at least 6/);
  const eleven = Array.from({ length: 11 }, (_, i) => ({ id: i + 1, word: 'ابت', display: 'ابت' }));
  assert.match(composeDay({ theme: 'ألوان', words: eleven, size: 10, seed: 1 }).problems.join(), /at most 10/);
  assert.equal(composeDay({ theme: '', words, size: 8, seed: 1 }).canSave, false);
  const badSize = composeDay({ theme: 'ألوان', words, size: 12, seed: 1 });
  assert.equal(badSize.board, null);
  assert.equal(badSize.canSave, false);
});

test('the preview draws column 0 on the right', () => {
  const { words } = readCustomWords(COLOURS.join('\n'));
  const { board } = composeDay({ theme: 'ألوان', words, size: 8, seed: 99 });
  const preview = previewOf(board);
  const w = preview.words[0];
  assert.equal(w.line.x1, 8 - w.col - 0.5);
  assert.equal(preview.cells.length, 8);
});
