import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { config } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Columns added after a table was first created.
 *
 * `CREATE TABLE IF NOT EXISTS` never adds a column to a table that is already
 * there, so a column only in schema.sql would reach a fresh database and not
 * the live one — and fail at write time, long after the deploy said it
 * succeeded. Every new column on an existing table goes here instead.
 */
const ADDITIVE_COLUMNS = [
  // text | image | emoji | audio. Rows from before types read as their media implies.
  ['questions', 'type', "TEXT NOT NULL DEFAULT 'text'"],
  ['questions', 'emoji', 'TEXT'],
  // The picture starts blurred; the app sells a help to sharpen it.
  ['questions', 'image_blurred', 'INTEGER NOT NULL DEFAULT 0'],
  // A generated name under the audio directory, never a path.
  ['questions', 'audio_file', 'TEXT'],
  // Shown above the question in the app. Replaces category, which older rows are backfilled from.
  ['questions', 'title', 'TEXT'],
  // Unused legacy from removed level packs; kept so existing databases match. Nothing reads or writes it.
  ['levels', 'pack_id', 'INTEGER REFERENCES packs(id) ON DELETE SET NULL'],
  ['levels', 'difficulty', "TEXT NOT NULL DEFAULT 'medium'"],
  // SHA-256 of the profile's recovery code (contract §7): the only way back in on another phone.
  ['profiles', 'recovery_hash', 'TEXT'],
  // Stars from the levels (contract §7): the main game's leaderboard.
  ['profiles', 'stars', 'INTEGER NOT NULL DEFAULT 0'],
  // The player's fastest total for all the daily games, ever (a personal record).
  ['profiles', 'best_allgames_seconds', 'INTEGER'],
  // The frame round the avatar (profiles.js FRAMES), or null for none.
  ['profiles', 'frame', 'TEXT'],
  // When this player was last told someone passed their time that day (one push a day).
  ['profile_daily', 'passed_notified_at', 'TEXT'],
  // Who took the picture, under which licence, and where it came from — shown on /credits and in the app.
  ['questions', 'image_author', 'TEXT'],
  ['questions', 'image_licence', 'TEXT'],
  ['questions', 'image_source', 'TEXT'],
  // easy | medium | hard, or null when not set: lets levels be built from easy questions first.
  ['questions', 'difficulty', 'TEXT'],
];

/** Adds a column when it is missing. Safe to run on every boot. True when it added one. */
function ensureColumn(database, table, column, definition) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === column)) return false;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

/** Opens a database and applies the schema. Every statement is idempotent. */
export function openDatabase(file) {
  const database = new Database(file);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
  for (const [table, column, definition] of ADDITIVE_COLUMNS) {
    const added = ensureColumn(database, table, column, definition);
    // Questions from before types existed: one with a picture was a picture
    // question, and must not read as plain text the moment the column appears.
    if (added && table === 'questions' && column === 'type') {
      database.exec("UPDATE questions SET type = 'image' WHERE image_file IS NOT NULL");
    }
  }
  // Questions from before titles: the old category becomes the title, once.
  // Rows that already have a title (every row saved since) are left alone.
  database.exec(`UPDATE questions SET title = substr(trim(category), 1, 40)
    WHERE title IS NULL AND category IS NOT NULL AND trim(category) <> ''`);
  // Days planned for games that no longer exist (contract §9): the kinds are
  // gone from the code, so their rows would only ever be dead weight.
  database.exec("DELETE FROM daily_game_days WHERE kind IN ('scramble', 'groups', 'picture')");
  // The kinds a planned day may hold live in a CHECK, which SQLite cannot alter,
  // so a database written under an older list of games is rebuilt once.
  const plannedDays = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'daily_game_days'").pluck().get();
  if (plannedDays && !plannedDays.includes("'bubbles', 'wheel', 'guess'")) {
    database.exec(`
      CREATE TABLE daily_game_days_new (
        date        TEXT NOT NULL,
        kind        TEXT NOT NULL CHECK (kind IN ('bubbles', 'wheel', 'guess')),
        game        TEXT NOT NULL,
        source      TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'typed')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (date, kind)
      );
      INSERT INTO daily_game_days_new SELECT * FROM daily_game_days WHERE kind IN ('bubbles', 'wheel', 'guess');
      DROP TABLE daily_game_days;
      ALTER TABLE daily_game_days_new RENAME TO daily_game_days;
    `);
  }
  // Indexes on added columns can only be made once the columns exist. (idx_levels_pack: unused legacy.)
  database.exec('CREATE INDEX IF NOT EXISTS idx_levels_pack ON levels(pack_id)');
  return database;
}

fs.mkdirSync(config.dataDir, { recursive: true });

// Tests open their own in-memory database; the file is only for the service.
export const db = config.env === 'test'
  ? openDatabase(':memory:')
  : openDatabase(path.join(config.dataDir, 'wasla.db'));

/** Kept for create-admin.js, which calls it before writing. */
export function migrate() {}
