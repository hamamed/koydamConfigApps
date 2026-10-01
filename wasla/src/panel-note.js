/**
 * «ملاحظاتي»: the one note the panel keeps under its header on every page —
 * things to remember and to do. One note for the panel, in the settings table,
 * so it is the same on every device and for every admin.
 */
export const MAX_NOTE_LENGTH = 5000;
const SETTING = 'panelNote';

export function createPanelNote(db) {
  const read = db.prepare('SELECT value FROM settings WHERE key = ?');
  const write = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`);

  /** `{ text, updatedAt, updatedBy }`; an empty note when none was written. */
  function get() {
    const row = read.get(SETTING);
    if (!row) return { text: '', updatedAt: null, updatedBy: null };
    try {
      const saved = JSON.parse(row.value);
      return { text: String(saved.text ?? ''), updatedAt: saved.updatedAt ?? null, updatedBy: saved.updatedBy ?? null };
    } catch {
      return { text: '', updatedAt: null, updatedBy: null };
    }
  }

  /** Keeps the text as typed (line ends made plain), up to MAX_NOTE_LENGTH. `{ note }` or `{ error }`. */
  function save(text, by = null) {
    const clean = String(text ?? '').replace(/\r\n?/g, '\n');
    if (clean.length > MAX_NOTE_LENGTH) return { error: `الملاحظة أطول من ${MAX_NOTE_LENGTH} حرف.` };
    const note = { text: clean, updatedAt: new Date().toISOString(), updatedBy: by };
    write.run(SETTING, JSON.stringify(note));
    return { note };
  }

  return { get, save };
}
