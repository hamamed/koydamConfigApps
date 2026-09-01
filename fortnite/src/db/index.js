import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { config } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new Database(path.join(config.dataDir, 'fortnite.db'));

// WAL lets readers run while a write is in flight. The sync job rewrites all
// sixteen thousand cosmetics in one transaction; without this, every app
// request during that window would fail with "database is locked".
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

/** Applies the schema. Every statement is `IF NOT EXISTS`, so it is safe on every boot. */
export function migrate() {
  db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
}

export const transaction = (fn) => db.transaction(fn);
