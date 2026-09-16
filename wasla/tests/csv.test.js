import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCsv } from '../src/csv.js';

test('splits plain rows and fields', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,2,3\n'), [['a', 'b', 'c'], ['1', '2', '3']]);
});

test('accepts CRLF line endings and a missing final newline', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2'), [['a', 'b'], ['1', '2']]);
});

test('keeps empty fields, including trailing ones', () => {
  assert.deepEqual(parseCsv('a,,c,\n'), [['a', '', 'c', '']]);
});

test('reads quoted fields with commas, doubled quotes and newlines inside', () => {
  const text = 'answer,clue\n"مصر","بلد، فيه ""الأهرامات""\nوالنيل"\n';
  assert.deepEqual(parseCsv(text), [['answer', 'clue'], ['مصر', 'بلد، فيه "الأهرامات"\nوالنيل']]);
});

test('drops a UTF-8 byte order mark from the first header', () => {
  assert.deepEqual(parseCsv('﻿answer,clue\nمصر,x\n'), [['answer', 'clue'], ['مصر', 'x']]);
});

test('skips blank lines between rows', () => {
  assert.deepEqual(parseCsv('a,b\n\n1,2\n\n'), [['a', 'b'], ['1', '2']]);
});

test('refuses an unterminated quote rather than guessing', () => {
  assert.throws(() => parseCsv('a,b\n"open,2\n'), /quote/i);
});

test('refuses a quote in the middle of an unquoted field', () => {
  assert.throws(() => parseCsv('a,b"c\n'), /quote/i);
});
