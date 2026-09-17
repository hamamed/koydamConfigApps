import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import Database from 'better-sqlite3';

import { openDatabase } from '../src/db/index.js';

/** A questions table as it was before titles existed. */
function databaseFromBeforeTitles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasla-db-'));
  const file = path.join(dir, 'wasla.db');
  const old = new Database(file);
  old.exec(`CREATE TABLE questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, answer TEXT NOT NULL, clue TEXT NOT NULL, category TEXT,
    image_file TEXT, image_zoom REAL NOT NULL DEFAULT 1, focus_x REAL NOT NULL DEFAULT 0.5, focus_y REAL NOT NULL DEFAULT 0.5,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const insert = old.prepare('INSERT INTO questions (answer, clue, category) VALUES (?, ?, ?)');
  insert.run('مصر', 'x', 'بلدان');
  insert.run('قمر', 'x', null);
  insert.run('اسد', 'x', '  ');
  insert.run('نمر', 'x', `  ${'ح'.repeat(50)} `);
  old.close();
  return { file, dir };
}

test('opening an older database adds the title column and backfills it from category, once', () => {
  const { file, dir } = databaseFromBeforeTitles();
  try {
    const db = openDatabase(file);
    const titles = () => db.prepare('SELECT answer, title FROM questions ORDER BY id').all().map((r) => [r.answer, r.title]);
    assert.deepEqual(titles(), [['مصر', 'بلدان'], ['قمر', null], ['اسد', null], ['نمر', 'ح'.repeat(40)]]);

    // A title set since is never overwritten by a later boot.
    db.prepare("UPDATE questions SET title = 'عواصم' WHERE answer = 'مصر'").run();
    db.close();
    const again = openDatabase(file);
    assert.equal(again.prepare("SELECT title FROM questions WHERE answer = 'مصر'").get().title, 'عواصم');
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a fresh database has the title column', () => {
  const db = openDatabase(':memory:');
  assert.ok(db.prepare('PRAGMA table_info(questions)').all().some((c) => c.name === 'title'));
});
