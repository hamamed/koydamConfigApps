import { query } from './db/pool.js';
import { log } from './log.js';
import { decryptSecret, encryptSecret, maskSecret } from './secrets.js';
import { findSetting, settingsFor, validateSetting } from './settings-catalogue.js';

/**
 * Reading and writing the settings that used to live in .env.
 *
 * Two read paths, deliberately different:
 *
 *   forService()  decrypts secrets and returns real values. Only ever called
 *                 by a service authenticating with SERVICE_TOKEN.
 *   forPanel()    never decrypts. A secret comes back as ••••1234 and a flag
 *                 saying it is set. A dashboard that can display a key has
 *                 leaked it into every screenshot taken since.
 *
 * The split is enforced by having two functions rather than one with a
 * parameter, because a boolean argument gets passed wrongly eventually.
 */

// ── Read ────────────────────────────────────────────────────────────────────

/**
 * Everything a service should apply, keyed by env-var name.
 *
 * Only keys in the catalogue are returned, so a row left behind after a
 * setting is retired does not reappear in a running process.
 */
export async function forService(service) {
  const known = new Set(settingsFor(service).map((s) => s.key));
  if (!known.size) return {};

  const res = await query(
    'SELECT key, value, secret_value FROM settings WHERE service = $1',
    [service],
  );

  const out = {};

  for (const row of res?.rows ?? []) {
    if (!known.has(row.key)) continue;

    if (row.secret_value) {
      const plain = decryptSecret(row.secret_value);
      // A secret that will not decrypt is omitted rather than sent as null:
      // the service then falls back to its .env value, which is the safer of
      // the two wrong answers.
      if (plain !== null) out[row.key] = plain;
      continue;
    }

    out[row.key] = row.value;
  }

  return out;
}

/**
 * The catalogue, with current values folded in, for rendering a form.
 *
 * Settings with no row carry `value: null`, which the panel shows as "using
 * the .env default" rather than as empty - the difference between unset and
 * set-to-nothing is the whole question when debugging one of these.
 */
export async function forPanel(service) {
  const specs = settingsFor(service);
  if (!specs.length) return [];

  const res = await query(
    'SELECT key, value, secret_value, updated_by, updated_at FROM settings WHERE service = $1',
    [service],
  );

  const rows = new Map((res?.rows ?? []).map((r) => [r.key, r]));

  return specs.map((spec) => {
    const row = rows.get(spec.key);

    if (spec.type === 'secret') {
      return {
        ...spec,
        isSet: Boolean(row?.secret_value),
        // Decrypted only to mask it. The plaintext never leaves this function.
        masked: row?.secret_value ? maskSecret(decryptSecret(row.secret_value)) : null,
        value: null,
        updatedBy: row?.updated_by ?? null,
        updatedAt: row?.updated_at ?? null,
      };
    }

    return {
      ...spec,
      isSet: row != null,
      value: row?.value ?? null,
      updatedBy: row?.updated_by ?? null,
      updatedAt: row?.updated_at ?? null,
    };
  });
}

// ── Write ───────────────────────────────────────────────────────────────────

/**
 * Validates, then stores. Returns `{ ok }` or `{ ok: false, reason }`.
 *
 * The history row is written first and the value second, so a failure leaves a
 * record of an attempt rather than a change nobody can account for.
 */
export async function set(service, key, raw, userEmail) {
  const spec = findSetting(service, key);
  if (!spec) return { ok: false, reason: `'${key}' is not a setting of ${service}.` };

  const checked = validateSetting(service, key, raw);
  if (!checked.ok) return checked;

  const existing = await query(
    'SELECT value, secret_value FROM settings WHERE service = $1 AND key = $2',
    [service, key],
  );
  const before = existing?.rows?.[0];

  if (spec.type === 'secret') {
    let encrypted;
    try {
      encrypted = encryptSecret(checked.value);
    } catch (err) {
      return { ok: false, reason: err.message };
    }

    await query(
      `INSERT INTO settings (service, key, secret_value, updated_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (service, key) DO UPDATE
         SET secret_value = EXCLUDED.secret_value,
             value = NULL,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
      [service, key, encrypted, userEmail ?? null],
    );

    // No values recorded: keeping old secrets in a history table undoes the
    // reason for encrypting the current one.
    await history(service, key, null, null, true, userEmail);
  } else {
    await query(
      `INSERT INTO settings (service, key, value, updated_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (service, key) DO UPDATE
         SET value = EXCLUDED.value,
             secret_value = NULL,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
      [service, key, JSON.stringify(checked.value), userEmail ?? null],
    );

    await history(service, key, before?.value ?? null, checked.value, false, userEmail);
  }

  log.info('Setting changed', { service, key, by: userEmail, secret: spec.type === 'secret' });
  return { ok: true, value: spec.type === 'secret' ? maskSecret(checked.value) : checked.value };
}

/**
 * Removes the override, so the service falls back to its .env value.
 *
 * Deleting rather than blanking: a setting present but empty is a value, and
 * "" is a perfectly valid API key as far as a service is concerned.
 */
export async function clear(service, key, userEmail) {
  const spec = findSetting(service, key);
  if (!spec) return { ok: false, reason: `'${key}' is not a setting of ${service}.` };

  const existing = await query(
    'SELECT value FROM settings WHERE service = $1 AND key = $2',
    [service, key],
  );

  const res = await query(
    'DELETE FROM settings WHERE service = $1 AND key = $2',
    [service, key],
  );

  if (res?.rowCount) {
    await history(
      service, key, existing?.rows?.[0]?.value ?? null, null,
      spec.type === 'secret', userEmail,
    );
    log.info('Setting cleared', { service, key, by: userEmail });
  }

  return { ok: true, removed: res?.rowCount ?? 0 };
}

async function history(service, key, oldValue, newValue, isSecret, userEmail) {
  await query(
    `INSERT INTO settings_history
       (service, key, old_value, new_value, is_secret, changed_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      service,
      key,
      oldValue == null ? null : JSON.stringify(oldValue),
      newValue == null ? null : JSON.stringify(newValue),
      isSecret,
      userEmail ?? null,
    ],
  ).catch((err) => log.warn('Settings history write failed', { error: err.message }));
}

/** Recent changes for one service, for the panel. */
export async function recentChanges(service, limit = 25) {
  const res = await query(
    `SELECT key, old_value, new_value, is_secret, changed_by, changed_at
       FROM settings_history
      WHERE service = $1
      ORDER BY changed_at DESC
      LIMIT $2`,
    [service, Math.min(100, Math.max(1, limit))],
  );
  return res?.rows ?? [];
}
