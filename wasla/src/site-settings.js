/**
 * Panel settings that are not game tuning, so they stay out of
 * GET /api/v1/config: for now the App Store link the challenge page offers.
 */

const APP_STORE_URL = 'appStoreUrl';
const MAX_URL = 300;

/** A checked App Store link ('' clears it), or `{ error }`. */
export function readAppStoreUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return { value: '' };
  let url;
  try {
    url = new URL(value);
  } catch {
    url = null;
  }
  if (!url || url.protocol !== 'https:' || value.length > MAX_URL) {
    return { error: 'رابط App Store يجب أن يبدأ بـ https://، مثل https://apps.apple.com/app/id1234567890.' };
  }
  return { value: url.toString() };
}

export function createSiteSettings(db, { envAppStoreUrl = '' } = {}) {
  const readSetting = (key) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    try {
      return row ? JSON.parse(row.value) : null;
    } catch {
      return null;
    }
  };

  /** The link set in the panel, else APP_STORE_URL from the environment, else ''. */
  const appStoreUrl = () => readSetting(APP_STORE_URL) || envAppStoreUrl || '';

  /** What the Settings field holds (the panel value only). */
  const storedAppStoreUrl = () => readSetting(APP_STORE_URL) || '';

  function saveAppStoreUrl(raw) {
    const { value, error } = readAppStoreUrl(raw);
    if (error) return { error };
    if (value) {
      db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(APP_STORE_URL, JSON.stringify(value));
    } else {
      db.prepare('DELETE FROM settings WHERE key = ?').run(APP_STORE_URL);
    }
    return { value };
  }

  return { appStoreUrl, storedAppStoreUrl, saveAppStoreUrl, envAppStoreUrl };
}
