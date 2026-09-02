import { db } from './db/index.js';

const statements = new Map();
const sql = (text) => {
  if (!statements.has(text)) statements.set(text, db.prepare(text));
  return statements.get(text);
};

/** A panel-managed value, or null. Read at request time, never cached at boot. */
export function setting(key) {
  const row = sql('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value || null;
}

export function setSetting(key, value) {
  const text = String(value ?? '').trim();
  if (!text) return clearSetting(key);
  return sql(
    `INSERT INTO settings (key, value) VALUES (@key, @value)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                    updated_at = datetime('now')`,
  ).run({ key, value: text });
}

export function clearSetting(key) {
  return sql('DELETE FROM settings WHERE key = ?').run(key);
}

export function settingUpdatedAt(key) {
  return sql('SELECT updated_at FROM settings WHERE key = ?').get(key)?.updated_at ?? null;
}

/**
 * Shows enough of a secret to recognise it, and not enough to use it.
 *
 * The panel has to confirm which key is installed — otherwise the only way to
 * check is to paste a new one and see whether things start working.
 */
export function maskedSetting(key) {
  const value = setting(key);
  if (!value) return null;
  if (value.length <= 8) return '•'.repeat(value.length);
  return `${value.slice(0, 4)}${'•'.repeat(Math.min(20, value.length - 8))}${value.slice(-4)}`;
}
