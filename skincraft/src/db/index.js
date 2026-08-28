import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { config } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new Database(path.join(config.dataDir, 'skincraft.db'));

// WAL lets readers run while a write is in flight. With an admin panel and a public API on the
// same file, the alternative is "database is locked" under any real traffic.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

/** Applies the schema. Every statement is `IF NOT EXISTS`, so this is safe to run on every boot. */
export function migrate() {
  db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));

  // `CREATE TABLE IF NOT EXISTS` silently does nothing when the table already exists, so columns
  // added to the schema after an install would never reach an existing database. Adding them
  // explicitly keeps a deployed instance and a fresh one on the same shape.
  ensureColumn('skins', 'color_hue', 'REAL');
  ensureColumn('skins', 'color_sat', 'REAL');
  ensureColumn('skins', 'color_light', 'REAL');
  ensureColumn('skins', 'color_hex', 'TEXT');
  ensureColumn('skins', 'design_meta', 'TEXT');

  // ALTER TABLE cannot add a UNIQUE column in SQLite, so the column goes on
  // plain and the index follows. Both are idempotent.
  ensureColumn('skins', 'likes', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('skins', 'dislikes', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'platform_id', 'INTEGER');
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS users_platform_id_idx '
    + 'ON users (platform_id) WHERE platform_id IS NOT NULL',
  );
}

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((entry) => entry.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/** better-sqlite3 is synchronous, so a transaction is just a wrapped function. */
export function transaction(fn) {
  return db.transaction(fn);
}
