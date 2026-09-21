/**
 * The APNs signing key and its ids, set on the panel's Notifications → Setup.
 *
 * The .p8 key is a file under data/apns/ (mode 0600, directory 0700): data/ is
 * preserved by deploys and never in git. The Key ID, Team ID and topic are
 * rows in the settings table. Nothing here ever returns the key to a page;
 * `status()` says whether one is there and which Key ID it belongs to.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_TEAM_ID = '652935W544';
export const DEFAULT_TOPIC = 'koydam.wasla.crosswords';
export const KEY_FILE = 'AuthKey.p8';
export const MAX_KEY_BYTES = 4096;

const KEY_ID = /^[A-Z0-9]{10}$/;
const TEAM_ID = /^[A-Z0-9]{10}$/;
const TOPIC = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const PKCS8_PEM = /^-----BEGIN PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PRIVATE KEY-----\s*$/;

const SETTING = { keyId: 'apnsKeyId', teamId: 'apnsTeamId', topic: 'apnsTopic', uploadedAt: 'apnsKeyUploadedAt' };

/**
 * The key as PEM text when the bytes are a PKCS#8 P-256 private key (what
 * Apple's .p8 download is), else `{ error }`.
 */
export function checkKeyFile(buffer) {
  if (!buffer?.length) return { error: 'اختر ملف المفتاح ‎.p8 من Apple.' };
  if (buffer.length > MAX_KEY_BYTES) return { error: 'هذا الملف أكبر من أن يكون مفتاح ‎.p8 لـAPNs.' };
  const text = buffer.toString('utf8').replace(/^﻿/, '').trim();
  if (!PKCS8_PEM.test(`${text}\n`)) {
    return { error: 'هذا ليس مفتاح ‎.p8: يجب أن يبدأ بـ "-----BEGIN PRIVATE KEY-----".' };
  }
  let key;
  try {
    key = crypto.createPrivateKey({ key: text, format: 'pem' });
  } catch {
    return { error: 'تعذّرت قراءة ملف ‎.p8 كمفتاح خاص.' };
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    return { error: 'هذا ليس مفتاح APNs: مفاتيح APNs من نوع EC P-256.' };
  }
  return { keyPem: `${text}\n` };
}

/** Checked ids, or `{ error }`. */
export function checkIds({ keyId, teamId, topic }) {
  const clean = {
    keyId: String(keyId ?? '').trim().toUpperCase(),
    teamId: String(teamId ?? '').trim().toUpperCase() || DEFAULT_TEAM_ID,
    topic: String(topic ?? '').trim() || DEFAULT_TOPIC,
  };
  if (!KEY_ID.test(clean.keyId)) return { error: 'Key ID هو العشرة حروف وأرقام المعروضة بجانب المفتاح في حساب Apple للمطوّرين.' };
  if (!TEAM_ID.test(clean.teamId)) return { error: 'Team ID عشرة حروف وأرقام.' };
  if (!TOPIC.test(clean.topic)) return { error: 'The topic is the app\'s bundle id, such as koydam.wasla.crosswords.' };
  return { ids: clean };
}

export function createApnsCredentials(db, { dir }) {
  const keyPath = path.join(dir, KEY_FILE);

  const read = (key) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  };
  const write = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`);

  const hasKey = () => {
    try {
      return fs.statSync(keyPath).isFile();
    } catch {
      return false;
    }
  };

  /** What the panel may show. Never the key. */
  function status() {
    const keyId = read(SETTING.keyId);
    return {
      configured: hasKey() && Boolean(keyId),
      hasKey: hasKey(),
      keyId,
      teamId: read(SETTING.teamId) || DEFAULT_TEAM_ID,
      topic: read(SETTING.topic) || DEFAULT_TOPIC,
      uploadedAt: read(SETTING.uploadedAt),
    };
  }

  /** Everything the sender needs, or null when setup is incomplete. */
  function load() {
    const current = status();
    if (!current.configured) return null;
    return { keyPem: fs.readFileSync(keyPath, 'utf8'), keyId: current.keyId, teamId: current.teamId, topic: current.topic };
  }

  /**
   * Saves the ids, and the key when a file is given. A first save needs a key;
   * later ones may change only the ids.
   */
  function save({ file, keyId, teamId, topic }) {
    const { ids, error } = checkIds({ keyId, teamId, topic });
    if (error) return { error };
    let keyPem = null;
    if (file?.length) {
      const checked = checkKeyFile(file);
      if (checked.error) return { error: checked.error };
      keyPem = checked.keyPem;
    } else if (!hasKey()) {
      return { error: 'اختر ملف المفتاح ‎.p8 من Apple.' };
    }

    if (keyPem) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      // Written beside the old one and renamed over it: a failed write never leaves half a key.
      const temp = path.join(dir, `.${KEY_FILE}.${process.pid}.tmp`);
      fs.writeFileSync(temp, keyPem, { mode: 0o600 });
      fs.chmodSync(temp, 0o600);
      fs.renameSync(temp, keyPath);
    }
    db.transaction(() => {
      write.run(SETTING.keyId, JSON.stringify(ids.keyId));
      write.run(SETTING.teamId, JSON.stringify(ids.teamId));
      write.run(SETTING.topic, JSON.stringify(ids.topic));
      if (keyPem) write.run(SETTING.uploadedAt, JSON.stringify(new Date().toISOString()));
    })();
    return { status: status(), replacedKey: Boolean(keyPem) };
  }

  /** Deletes the key file and the ids. */
  function remove() {
    fs.rmSync(keyPath, { force: true });
    db.prepare('DELETE FROM settings WHERE key IN (?, ?, ?, ?)').run(SETTING.keyId, SETTING.teamId, SETTING.topic, SETTING.uploadedAt);
  }

  return { status, load, save, remove, keyPath };
}
