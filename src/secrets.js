import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { config } from './config.js';
import { log } from './log.js';

/**
 * Encrypting the secrets that live in the database.
 *
 * ## Why they are encrypted and not simply stored
 *
 * backup.sh dumps every database and copies the archive off this box. A
 * Supercell token or an image-API key stored as plain text would therefore sit
 * in an archive on somebody else's storage, and a database dump - the thing
 * most likely to be copied around, pasted into a ticket, or restored onto a
 * laptop - would carry every credential the estate has.
 *
 * Encrypted, the database alone is useless: the key stays in .env on the box,
 * which is the one place a dump does not reach.
 *
 * ## AES-256-GCM
 *
 * Authenticated, so a modified ciphertext fails to decrypt rather than
 * silently yielding different bytes. A random 12-byte nonce per value, stored
 * alongside - reusing a nonce with the same key is the one mistake that breaks
 * GCM outright.
 */

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * The key, derived from SETTINGS_KEY.
 *
 * Hashed rather than used raw so any length of passphrase yields the 32 bytes
 * the cipher needs. Not a KDF: this is a machine-generated key from .env, not
 * a human password, so there is nothing to stretch.
 */
function key() {
  const raw = config.settingsKey;
  if (!raw) return null;
  return createHash('sha256').update(raw, 'utf8').digest();
}

export function isEncryptionConfigured() {
  return Boolean(config.settingsKey);
}

/**
 * Returns `nonce:tag:ciphertext`, base64 each.
 *
 * Three parts rather than one blob so a value can be inspected in psql and
 * recognised as encrypted at a glance, rather than looking like corrupt text.
 */
export function encryptSecret(plaintext) {
  const k = key();
  if (!k) {
    throw new Error(
      'SETTINGS_KEY is not set. Secrets cannot be stored until it is.',
    );
  }

  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, k, nonce);

  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);

  return [
    nonce.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

/**
 * Returns the plaintext, or null.
 *
 * Null rather than throwing: a value that cannot be decrypted - because the
 * key was rotated, or the row was written by a different install - should
 * degrade to "this setting is unset" and let the service fall back to its
 * .env value, not crash the process that asked.
 */
export function decryptSecret(stored) {
  const k = key();
  if (!k || !stored) return null;

  const parts = String(stored).split(':');
  if (parts.length !== 3) {
    log.warn('Stored secret is not in nonce:tag:ciphertext form');
    return null;
  }

  try {
    const [nonce, tag, payload] = parts.map((p) => Buffer.from(p, 'base64'));

    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
      log.warn('Stored secret has the wrong nonce or tag length');
      return null;
    }

    const decipher = createDecipheriv(ALGORITHM, k, nonce);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, or tampered ciphertext. Both look the same here, which is
    // what authenticated encryption is for.
    log.warn('A stored secret could not be decrypted - was SETTINGS_KEY changed?');
    return null;
  }
}

/**
 * What the panel is allowed to show.
 *
 * The last four characters and nothing else. Enough to answer "is this the key
 * I think it is" without the value ever reaching a browser, a screenshot, or a
 * support thread.
 */
export function maskSecret(plaintext) {
  const s = String(plaintext ?? '');
  if (!s) return null;
  if (s.length <= 4) return '••••';
  return '••••' + s.slice(-4);
}

/** Constant-time compare, for anywhere a submitted secret is checked. */
export function secretsMatch(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}
