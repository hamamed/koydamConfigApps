import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readPastedQuestions } from '../src/paste-import.js';

const pairs = (text, options) => readPastedQuestions(text, { title: 'عام', ...options }).rows
  .map(({ values }) => [values.clue, values.answer]);

test('one question per line with the usual separators, numbering dropped', () => {
  assert.deepEqual(pairs([
    '1- عاصمة المغرب - الرباط',
    '2. عاصمة تونس: تونس',
    '(3) عاصمة لبنان = بيروت',
    '• عاصمة الأردن | عمان',
    'عاصمة قطر\tالدوحة',
    'عاصمة ليبيا → طرابلس',
  ].join('\n')), [
    ['عاصمة المغرب', 'الرباط'], ['عاصمة تونس', 'تونس'], ['عاصمة لبنان', 'بيروت'],
    ['عاصمة الأردن', 'عمان'], ['عاصمة قطر', 'الدوحة'], ['عاصمة ليبيا', 'طرابلس'],
  ]);
});

test('a question mark ends the clue, and the answer loses its punctuation', () => {
  assert.deepEqual(pairs('ما عاصمة مصر؟ القاهرة.\nما أكبر كوكب؟ - «المشتري» (كوكب غازي)'), [
    ['ما عاصمة مصر؟', 'القاهرة'], ['ما أكبر كوكب؟', 'المشتري'],
  ]);
});

test('labelled pairs and clue-then-answer lines', () => {
  assert.deepEqual(pairs('س: أكبر محيط في العالم\nج: الهادي\nالسؤال 2: أطول نهر\nالإجابة: النيل\nحيوان يلقب بملك الغابة\nالأسد'), [
    ['أكبر محيط في العالم', 'الهادي'], ['أطول نهر', 'النيل'], ['حيوان يلقب بملك الغابة', 'الأسد'],
  ]);
});

test('the order setting decides which side is the answer', () => {
  assert.deepEqual(pairs('أسد - حيوان مفترس يعيش في الغابة'), [['حيوان مفترس يعيش في الغابة', 'أسد']]);
  assert.deepEqual(pairs('نمر - أسد', { order: 'answer-first' }), [['أسد', 'نمر']]);
  assert.deepEqual(pairs('نمر - أسد', { order: 'clue-first' }), [['نمر', 'أسد']]);
});

test('# lines set the title; the default title and level fill the rest', () => {
  const { rows } = readPastedQuestions('قط - حيوان أليف يموء\n# فواكه\nتفاحة - فاكهة حمراء أو خضراء', { title: 'حيوانات', level: '3' });
  assert.deepEqual(rows.map((r) => [r.values.title, r.values.level, r.values.answer]), [
    ['حيوانات', '3', 'قط'], ['فواكه', '3', 'تفاحة'],
  ]);
});

test('a clue left without its answer still shows, and empty text is refused', () => {
  assert.deepEqual(pairs('سؤال بلا جواب؟'), [['سؤال بلا جواب؟', '']]);
  assert.match(readPastedQuestions('  \n ').error, /الصق/);
  assert.match(readPastedQuestions('# عنوان فقط').error, /لم يُعثر على أسئلة/);
});

test('a colon inside a question does not split it; its answer comes from the next line', () => {
  assert.deepEqual(pairs([
    '6- ماذا تعني الكلمة التالية: أفلاطون؟',
    'فيلسوف',
    '7- ما معنى كلمة: السراب؟ - وهم',
    'ما عاصمة اليابان؟',
    'ما عاصمة الصين؟',
    'بكين',
  ].join('\n')), [
    ['ماذا تعني الكلمة التالية: أفلاطون؟', 'فيلسوف'],
    ['ما معنى كلمة: السراب؟', 'وهم'],
    ['ما عاصمة اليابان؟', ''],
    ['ما عاصمة الصين؟', 'بكين'],
  ]);
});

test('with answers first, "answer: question?" still splits', () => {
  assert.deepEqual(pairs('القاهرة: ما عاصمة مصر؟', { order: 'answer-first' }), [['ما عاصمة مصر؟', 'القاهرة']]);
});

test('a clue without its answer does not swallow the next whole question', () => {
  assert.deepEqual(pairs('سؤال بلا جواب؟\nكوكب أحمر - المريخ'), [['سؤال بلا جواب؟', ''], ['كوكب أحمر', 'المريخ']]);
});
