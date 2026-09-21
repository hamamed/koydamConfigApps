/**
 * Panel settings that are not game tuning, so they stay out of
 * GET /api/v1/config: the two store links the landing and challenge pages use.
 */

const APP_STORE_URL = 'appStoreUrl';
const PLAY_URL = 'playUrl';
const MAX_URL = 300;

/** A checked https link ('' clears it), or `{ error }` worded for that store. */
function readStoreUrl(raw, error) {
  const value = String(raw ?? '').trim();
  if (!value) return { value: '' };
  let url;
  try {
    url = new URL(value);
  } catch {
    url = null;
  }
  if (!url || url.protocol !== 'https:' || value.length > MAX_URL) return { error };
  return { value: url.toString() };
}

/** A checked App Store link ('' clears it), or `{ error }`. */
export const readAppStoreUrl = (raw) => readStoreUrl(raw,
  'رابط App Store يجب أن يبدأ بـ https://، مثل https://apps.apple.com/app/id1234567890.');

/** A checked Google Play link ('' clears it), or `{ error }`. */
export const readPlayUrl = (raw) => readStoreUrl(raw,
  'رابط Google Play يجب أن يبدأ بـ https://، مثل https://play.google.com/store/apps/details?id=com.example.');

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

  /** The Google Play link, set in the panel; '' until the app is there. */
  const playUrl = () => readSetting(PLAY_URL) || '';

  function savePlayUrl(raw) {
    const { value, error } = readPlayUrl(raw);
    if (error) return { error };
    if (value) {
      db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(PLAY_URL, JSON.stringify(value));
    } else {
      db.prepare('DELETE FROM settings WHERE key = ?').run(PLAY_URL);
    }
    return { value };
  }

  return { appStoreUrl, storedAppStoreUrl, saveAppStoreUrl, playUrl, savePlayUrl, envAppStoreUrl };
}
