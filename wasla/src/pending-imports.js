/**
 * Imports between upload and confirm.
 *
 * Kept in the database rather than the session: the payload holds every
 * checked row, and a row here can be found and cleaned up — with the media
 * already stored for it — when nobody ever confirms.
 */
import crypto from 'node:crypto';

export const PENDING_IMPORT_HOURS = 24;
const ID = /^[a-f0-9]{32}$/;

export function createPendingImports(db) {
  function save(payload) {
    const id = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO imports (id, payload) VALUES (?, ?)').run(id, JSON.stringify(payload));
    return id;
  }

  function get(id) {
    if (!ID.test(String(id))) return null;
    const row = db.prepare('SELECT payload FROM imports WHERE id = ?').get(id);
    return row ? JSON.parse(row.payload) : null;
  }

  /** Keeps the admin's edits to a pending import. */
  function update(id, payload) {
    if (!ID.test(String(id))) return;
    db.prepare('UPDATE imports SET payload = ? WHERE id = ?').run(JSON.stringify(payload), id);
  }

  function remove(id) {
    db.prepare('DELETE FROM imports WHERE id = ?').run(String(id));
  }

  /** Imports nobody confirmed within the window: `[{ id, payload }]`. */
  function stale(hours = PENDING_IMPORT_HOURS) {
    return db.prepare("SELECT id, payload FROM imports WHERE created_at < datetime('now', ?)")
      .all(`-${Number(hours)} hours`)
      .map((row) => ({ id: row.id, payload: JSON.parse(row.payload) }));
  }

  return { save, get, update, remove, stale };
}
