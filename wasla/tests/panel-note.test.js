import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openDatabase } from '../src/db/index.js';
import { createPanelNote, MAX_NOTE_LENGTH } from '../src/panel-note.js';

test('the note starts empty, keeps what is typed, and says who wrote it last', () => {
  const note = createPanelNote(openDatabase(':memory:'));
  assert.deepEqual(note.get(), { text: '', updatedAt: null, updatedBy: null });
  assert.equal(note.save('اربط صفحة فيسبوك\r\nأضف روابط إنستغرام', 'med').error, undefined);
  const saved = note.get();
  assert.equal(saved.text, 'اربط صفحة فيسبوك\nأضف روابط إنستغرام', 'line ends made plain');
  assert.equal(saved.updatedBy, 'med');
  assert.match(saved.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  note.save('', 'med');
  assert.equal(note.get().text, '', 'it can be cleared');
});

test('a note longer than the limit is refused, and the old one stays', () => {
  const note = createPanelNote(openDatabase(':memory:'));
  note.save('قصيرة');
  assert.ok(note.save('ا'.repeat(MAX_NOTE_LENGTH + 1)).error);
  assert.equal(note.get().text, 'قصيرة');
  assert.equal(note.save('ا'.repeat(MAX_NOTE_LENGTH)).error, undefined);
});
