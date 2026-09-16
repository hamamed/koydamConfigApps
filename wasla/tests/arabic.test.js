import assert from 'node:assert/strict';
import { test } from 'node:test';

import { answerProblem, foldForPlay, letters, normalizeAnswer } from '../src/arabic.js';

test('strips diacritics, tatweel and spaces from an answer', () => {
  assert.equal(normalizeAnswer('  المَغْرِب '), 'المغرب');
  assert.equal(normalizeAnswer('كـــرة'), 'كرة');
  assert.equal(normalizeAnswer('كرة القدم'), 'كرةالقدم');
});

test('splits an answer into one letter per cell', () => {
  assert.deepEqual(letters('مصر'), ['م', 'ص', 'ر']);
  assert.deepEqual(letters('لا'), ['ل', 'ا']);
});

test('accepts Arabic words of two to twelve letters', () => {
  assert.equal(answerProblem('المغرب'), null);
  assert.equal(answerProblem('أسد'), null);
});

test('rejects answers a player could not spell with the letter bank', () => {
  assert.match(answerProblem(''), /required/);
  assert.match(answerProblem('ب'), /at least 2/);
  assert.match(answerProblem('ابتثجحخدذرزسش'), /at most 12/);
  assert.match(answerProblem('Paris'), /Arabic letters/);
  assert.match(answerProblem('مصر2'), /Arabic letters/);
});

test('folds hamza and alef forms the player does not tell apart', () => {
  assert.equal(foldForPlay('أسد'), 'اسد');
  assert.equal(foldForPlay('إبريق'), 'ابريق');
  assert.equal(foldForPlay('آمال'), 'امال');
  assert.equal(foldForPlay('ٱلله'), 'الله');
  assert.equal(foldForPlay('مؤمن'), 'مومن');
  assert.equal(foldForPlay('بئر'), 'بير');
  assert.equal(foldForPlay('مستشفى'), 'مستشفي');
});

test('keeps standalone hamza and taa marbuta as they are', () => {
  assert.equal(foldForPlay('سماء'), 'سماء');
  assert.equal(foldForPlay('كرة'), 'كرة');
  assert.equal(foldForPlay('المغرب'), 'المغرب');
});

test('an answer written with alef wasla is still a valid answer', () => {
  assert.equal(answerProblem('ٱلله'), null);
});
