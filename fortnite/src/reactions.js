import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { config } from './config.js';
import { db } from './db/index.js';

export const PHOTO_ROOT = path.resolve(config.dataDir, 'reaction-photos');
fs.mkdirSync(PHOTO_ROOT, { recursive: true });

export const KINDS = ['fire', 'love', 'cool', 'meh', 'trash'];

const statements = new Map();
const sql = (text) => {
  if (!statements.has(text)) statements.set(text, db.prepare(text));
  return statements.get(text);
};

/**
 * Who is reacting, without knowing who they are.
 *
 * A hash of the device id the app keeps in its keychain, salted with this
 * service's secret. It is enough to enforce one reaction per person and to
 * block an abusive device, and it identifies nobody — the raw id never lands
 * in the database and the hash cannot be reversed into one.
 *
 * Without a device id it falls back to address and agent for the day. That is
 * weaker on purpose: it is a floor for a request that forgot the header, not
 * something to rely on.
 */
export function clientKey(req) {
  const device = (req.get('x-device-id') || '').trim();

  if (device) {
    return crypto
      .createHash('sha256')
      .update(`device|${config.sessionSecret}|${device.slice(0, 200)}`)
      .digest('hex')
      .slice(0, 32);
  }

  const day = new Date().toISOString().slice(0, 10);
  return crypto
    .createHash('sha256')
    .update(`${day}|${config.sessionSecret}|${req.ip || ''}|${req.get('user-agent') || ''}`)
    .digest('hex')
    .slice(0, 32);
}

export function isBlocked(key) {
  return !!sql('SELECT 1 FROM blocked_clients WHERE client_key = ?').get(key);
}

/** Sets, changes or clears one person's reaction to an item. */
export function setReaction(itemId, key, kind) {
  if (kind === null) {
    sql('DELETE FROM reactions WHERE item_id = ? AND client_key = ?').run(itemId, key);
    return { kind: null };
  }
  if (!KINDS.includes(kind)) return { error: 'That is not a reaction.' };

  sql(
    `INSERT INTO reactions (item_id, client_key, kind) VALUES (@item, @key, @kind)
     ON CONFLICT(item_id, client_key) DO UPDATE SET kind = excluded.kind,
                                                   updated_at = datetime('now')`,
  ).run({ item: itemId, key, kind });
  return { kind };
}

/** Every reaction count for an item, plus what this person chose. */
export function reactionsFor(itemId, key) {
  const rows = sql(
    'SELECT kind, COUNT(*) AS n FROM reactions WHERE item_id = ? GROUP BY kind',
  ).all(itemId);

  const counts = Object.fromEntries(KINDS.map((k) => [k, 0]));
  for (const row of rows) counts[row.kind] = row.n;

  const mine = key
    ? sql('SELECT kind FROM reactions WHERE item_id = ? AND client_key = ?').get(itemId, key)
    : null;

  return { counts, total: rows.reduce((sum, r) => sum + r.n, 0), yours: mine?.kind ?? null };
}

/**
 * Counts for many items at once, for a grid.
 *
 * One query rather than one per card: a locker page is sixty items, and sixty
 * round trips to answer "how many likes" is how a list becomes slow.
 */
export function reactionTotals(itemIds) {
  if (!itemIds.length) return {};
  const marks = itemIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT item_id, COUNT(*) AS n FROM reactions WHERE item_id IN (${marks}) GROUP BY item_id`)
    .all(itemIds);
  return Object.fromEntries(rows.map((r) => [r.item_id, r.n]));
}

/**
 * What a file actually is, read from its first bytes.
 *
 * Never the filename or the declared content type, both of which are supplied
 * by whoever is uploading. A .jpg that begins with `%PDF` is a PDF, and the
 * only way to know is to look.
 */
export function sniffImage(buffer) {
  if (buffer.length < 12) return null;
  const b = buffer;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

const photoPath = (id) => path.join(PHOTO_ROOT, id.slice(0, 2), `${id}.bin`);

/** Stores a photo as pending. Nothing is visible until a person approves it. */
export function storePhoto({ itemId, key, buffer, caption }) {
  const type = sniffImage(buffer);
  if (!type) return { ok: false, reason: 'That is not a PNG, JPEG or WebP image.' };
  if (buffer.length > config.reactions.maxPhotoBytes) {
    return { ok: false, reason: 'That image is too large.' };
  }

  const id = crypto.randomUUID();
  const file = photoPath(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer);

  sql(
    `INSERT INTO reaction_photos (id, item_id, client_key, caption, content_type, bytes)
     VALUES (@id, @item, @key, @caption, @type, @bytes)`,
  ).run({
    id,
    item: itemId,
    key,
    caption: String(caption ?? '').slice(0, 140).trim(),
    type,
    bytes: buffer.length,
  });

  return { ok: true, id, status: 'pending' };
}

export function photoFile(id) {
  const row = sql('SELECT * FROM reaction_photos WHERE id = ?').get(id);
  if (!row) return null;
  const file = photoPath(id);
  return fs.existsSync(file) ? { row, file } : null;
}

/** Only approved photos, for the app. */
export function approvedPhotos(itemId, limit = 30) {
  return sql(
    `SELECT id, caption, created_at FROM reaction_photos
      WHERE item_id = ? AND status = 'approved'
      ORDER BY created_at DESC LIMIT ?`,
  ).all(itemId, limit);
}

/** How many photos this device has sent today, for the daily cap. */
export function photosToday(key) {
  return sql(
    `SELECT COUNT(*) AS n FROM reaction_photos
      WHERE client_key = ? AND created_at > datetime('now', '-1 day')`,
  ).get(key).n;
}

export function reviewPhoto(id, status, userId) {
  return sql(
    `UPDATE reaction_photos
        SET status = @status, reviewed_at = datetime('now'), reviewed_by = @user
      WHERE id = @id`,
  ).run({ id, status, user: userId ?? null });
}

/** Removes a photo's row and its file. */
export function deletePhoto(id) {
  const file = photoPath(id);
  try { fs.rmSync(file, { force: true }); } catch { /* already gone */ }
  return sql('DELETE FROM reaction_photos WHERE id = ?').run(id);
}

export function blockClient(key, reason) {
  return sql(
    `INSERT INTO blocked_clients (client_key, reason) VALUES (?, ?)
     ON CONFLICT(client_key) DO UPDATE SET reason = excluded.reason`,
  ).run(key, String(reason ?? '').slice(0, 200));
}

export function unblockClient(key) {
  return sql('DELETE FROM blocked_clients WHERE client_key = ?').run(key);
}

export function reportPhoto(photoId, key, reason) {
  if (!sql('SELECT 1 FROM reaction_photos WHERE id = ?').get(photoId)) {
    return { ok: false, reason: 'No such photo.' };
  }
  sql(
    'INSERT INTO reaction_reports (photo_id, client_key, reason) VALUES (?, ?, ?)',
  ).run(photoId, key, String(reason ?? '').slice(0, 200));
  return { ok: true };
}

/** The moderation queue, and what the panel shows beside it. */
export function moderationSummary() {
  return {
    pending: sql("SELECT COUNT(*) AS n FROM reaction_photos WHERE status = 'pending'").get().n,
    approved: sql("SELECT COUNT(*) AS n FROM reaction_photos WHERE status = 'approved'").get().n,
    rejected: sql("SELECT COUNT(*) AS n FROM reaction_photos WHERE status = 'rejected'").get().n,
    reports: sql("SELECT COUNT(*) AS n FROM reaction_reports WHERE status = 'open'").get().n,
    reactions: sql('SELECT COUNT(*) AS n FROM reactions').get().n,
    blocked: sql('SELECT COUNT(*) AS n FROM blocked_clients').get().n,
  };
}
