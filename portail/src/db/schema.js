/**
 * The portal's schema — the accounts, and nothing else.
 *
 * This service owns identity for the civictrust family: one account signs in
 * here and the session is accepted by every service on the domain. It holds no
 * procurement data of its own; bdc and marches each keep their own database and
 * resolve a local row from the signed-in email, so their foreign keys
 * (favourites, invoices, saved searches) keep pointing at rows in their own
 * schema rather than across a service boundary.
 *
 * Same portability rules as the other services: ISO-8601 TEXT for dates so
 * lexicographic ordering is chronological ordering on both SQLite and Postgres,
 * and INTEGER 0/1 for booleans.
 */
const idColumn = (dialect) =>
  dialect === 'postgres' ? 'id SERIAL PRIMARY KEY' : 'id INTEGER PRIMARY KEY AUTOINCREMENT'

export function tableStatements(dialect) {
  const id = idColumn(dialect)
  return [
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS users (
      ${id},
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      -- Which services this account may open. Stored as a comma-separated list
      -- rather than a join table because it is read on every page load and has
      -- at most a handful of values; "bdc,marches" is the common case.
      services TEXT NOT NULL DEFAULT 'bdc,marches',
      role TEXT NOT NULL DEFAULT 'user',
      is_active INTEGER NOT NULL DEFAULT 1,
      last_login_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS password_resets (
      ${id},
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    )`,

    // Who signed in, from where, and which service they went on to open. The
    // one place a shared login can be audited: neither bdc nor marches sees a
    // password any more, so a failed attempt leaves no trace in either of them.
    `CREATE TABLE IF NOT EXISTS sign_ins (
      ${id},
      user_id INTEGER,
      email TEXT NOT NULL,
      outcome TEXT NOT NULL,
      service TEXT,
      ip TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL
    )`,
  ]
}

export function indexStatements() {
  return [
    'CREATE INDEX IF NOT EXISTS idx_users_email ON users (email)',
    'CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets (user_id)',
    'CREATE INDEX IF NOT EXISTS idx_sign_ins_created ON sign_ins (created_at)',
    'CREATE INDEX IF NOT EXISTS idx_sign_ins_email ON sign_ins (email)',
  ]
}

/**
 * `CREATE TABLE IF NOT EXISTS` never adds a column to a table that already
 * exists, so a column added above must also be named here or it never reaches a
 * database created by an earlier deploy — and the failure shows up at write
 * time, long after the deploy reported success.
 */
export function additiveColumns() {
  return []
}

export const SCHEMA_VERSION = '2026-09-08.001'
