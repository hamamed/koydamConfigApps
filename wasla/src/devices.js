/**
 * Installs that can receive push notifications (POST /api/v1/devices).
 *
 * One row per install, keyed by the same random id the events carry. The app
 * posts whenever its token or its notification permission changes; a player
 * turning notifications off keeps the row with `enabled` 0 so nothing is sent.
 */

export const PLATFORMS = ['ios'];
export const ENVIRONMENTS = ['production', 'sandbox'];
export const TARGETS = ['all', 'sandbox', 'device'];

const DEVICE = /^[A-Za-z0-9-]{8,64}$/;
const TOKEN = /^[0-9a-fA-F]{64,200}$/;
// "ar", "en-US", "zh_Hant_TW": a language code and optional subtags.
const LOCALE = /^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8}){0,3}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const isDeviceId = (value) => typeof value === 'string' && DEVICE.test(value);

/** The row to store, or `{ error }` for a 400. */
export function readDeviceRegistration(body) {
  if (!isObject(body)) return { error: 'The body must be a JSON object with "device", "token", "platform" and "environment".' };
  if (!isDeviceId(body.device)) {
    return { error: '"device" must be the random id the app generated (8 to 64 letters, digits or hyphens).' };
  }
  if (typeof body.token !== 'string' || !TOKEN.test(body.token)) {
    return { error: '"token" must be the APNs device token as 64 to 200 hexadecimal characters.' };
  }
  if (!PLATFORMS.includes(body.platform)) return { error: `"platform" must be one of: ${PLATFORMS.join(', ')}.` };
  if (!ENVIRONMENTS.includes(body.environment)) {
    return { error: `"environment" must be one of: ${ENVIRONMENTS.join(', ')}.` };
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return { error: '"enabled" must be true or false.' };
  if (body.locale !== undefined && body.locale !== null && (typeof body.locale !== 'string' || !LOCALE.test(body.locale))) {
    return { error: '"locale" must be a language code such as "ar" or "en-US".' };
  }
  return {
    registration: {
      device: body.device,
      token: body.token.toLowerCase(),
      platform: body.platform,
      environment: body.environment,
      // Absent reads as on: an app that registers a token has permission.
      enabled: body.enabled === false ? 0 : 1,
      locale: body.locale ?? null,
    },
  };
}

export function createDevices(db) {
  const upsert = db.prepare(`INSERT INTO devices (device, token, platform, environment, enabled, locale)
    VALUES (@device, @token, @platform, @environment, @enabled, @locale)
    ON CONFLICT(device) DO UPDATE SET
      token = excluded.token, platform = excluded.platform, environment = excluded.environment,
      enabled = excluded.enabled, locale = excluded.locale, updated_at = datetime('now'),
      -- A new token starts clean; the same token keeps its failure history.
      failures = CASE WHEN devices.token = excluded.token THEN devices.failures ELSE 0 END,
      last_error = CASE WHEN devices.token = excluded.token THEN devices.last_error ELSE NULL END`);
  // A reinstall gets a new install id but can get the same token back; the old
  // row would make every send reach that phone twice.
  const dropStale = db.prepare('DELETE FROM devices WHERE token = ? AND device <> ?');

  /** Stores a checked registration. */
  function register(registration) {
    db.transaction(() => {
      dropStale.run(registration.token, registration.device);
      upsert.run(registration);
    })();
  }

  const toDevice = (row) => row && ({
    device: row.device,
    token: row.token,
    platform: row.platform,
    environment: row.environment,
    enabled: Boolean(row.enabled),
    locale: row.locale,
    failures: row.failures,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  });

  function get(device) {
    return toDevice(db.prepare('SELECT * FROM devices WHERE device = ?').get(String(device)));
  }

  /**
   * The enabled devices a send reaches: every one, the sandbox ones (builds
   * from Xcode and TestFlight-less test phones), or one device by its id.
   */
  function targets(target, deviceId = null) {
    if (target === 'all') return db.prepare('SELECT * FROM devices WHERE enabled = 1 ORDER BY device').all().map(toDevice);
    if (target === 'sandbox') {
      return db.prepare("SELECT * FROM devices WHERE enabled = 1 AND environment = 'sandbox' ORDER BY device").all().map(toDevice);
    }
    if (target === 'device') {
      const one = get(deviceId);
      return one?.enabled ? [one] : [];
    }
    return [];
  }

  function counts() {
    return db.prepare(`SELECT COUNT(*) AS total,
      IFNULL(SUM(enabled = 1), 0) AS enabled,
      IFNULL(SUM(enabled = 1 AND environment = 'sandbox'), 0) AS sandbox,
      IFNULL(SUM(enabled = 1 AND environment = 'production'), 0) AS production
      FROM devices`).get();
  }

  function markSent(device) {
    db.prepare('UPDATE devices SET failures = 0, last_error = NULL WHERE device = ?').run(device);
  }

  function markFailed(device, reason) {
    db.prepare('UPDATE devices SET failures = failures + 1, last_error = ? WHERE device = ?').run(String(reason).slice(0, 200), device);
  }

  /** APNs said the token is gone: stop sending to it. */
  function disable(device, reason) {
    db.prepare("UPDATE devices SET enabled = 0, last_error = ?, updated_at = datetime('now') WHERE device = ?")
      .run(String(reason).slice(0, 200), device);
  }

  return { register, get, targets, counts, markSent, markFailed, disable };
}
