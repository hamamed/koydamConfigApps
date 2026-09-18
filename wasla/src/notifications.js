/**
 * Notifications written in the panel and pushed to players, with a history of
 * what each send reached.
 */

import { buildPayload } from './apns.js';
import { isDeviceId, TARGETS } from './devices.js';

export const MAX_TITLE = 60;
export const MAX_BODY = 180;
export const NOT_SET_UP = 'Set up APNs first: upload the .p8 key and its Key ID on Notifications → Setup. Nothing was sent.';

const length = (s) => [...s].length;

/**
 * A checked message, or `{ error }`. `publishedCount` bounds the level: the
 * app opens a level by its public number, so only a published one makes sense.
 */
export function readCompose(input, { publishedCount }) {
  const title = String(input?.title ?? '').trim();
  const body = String(input?.body ?? '').trim();
  const rawLevel = String(input?.level ?? '').trim();
  const target = String(input?.target ?? 'all');
  const device = String(input?.device ?? '').trim();

  if (!title) return { error: 'Write a title.' };
  if (length(title) > MAX_TITLE) return { error: `The title is at most ${MAX_TITLE} characters.` };
  if (!body) return { error: 'Write the message.' };
  if (length(body) > MAX_BODY) return { error: `The message is at most ${MAX_BODY} characters.` };

  let level = null;
  if (rawLevel) {
    if (!/^\d+$/.test(rawLevel) || Number(rawLevel) < 1) return { error: 'The level is a level number, such as 3.' };
    level = Number(rawLevel);
    if (level > publishedCount) {
      return { error: publishedCount ? `There is no level ${level} in the app: levels 1 to ${publishedCount} are published.` : 'No level is published yet, so a notification cannot open one.' };
    }
  }

  if (!TARGETS.includes(target)) return { error: 'Choose who receives it.' };
  if (target === 'device' && !isDeviceId(device)) return { error: 'For a test send, paste the device id (the install id the app reports).' };

  return { message: { title, body, level, target, device: target === 'device' ? device : null } };
}

export function createNotifications(db, { devices, credentials, sender }) {
  const insert = db.prepare(`INSERT INTO notifications (title, body, level, target, device, total, sent, failed, disabled, errors, created_by)
    VALUES (@title, @body, @level, @target, @device, @total, @sent, @failed, @disabled, @errors, @createdBy)`);

  /** How many enabled devices a message would reach. */
  const audience = (message) => devices.targets(message.target, message.device).length;

  /**
   * Sends a checked message. `{ error }` when APNs is not set up or nobody
   * would receive it (nothing is recorded then); otherwise the summary, after
   * dead tokens are disabled and the send is recorded.
   */
  async function send(message, { userId = null } = {}) {
    const keys = credentials.load();
    if (!keys) return { error: NOT_SET_UP };
    const targets = devices.targets(message.target, message.device);
    if (!targets.length) {
      return { error: message.target === 'device' ? 'That device is not registered, or has notifications turned off.' : 'No device with notifications on matches that target. Nothing was sent.' };
    }

    const summary = await sender.send({ credentials: keys, devices: targets, payload: buildPayload(message) });
    db.transaction(() => {
      for (const r of summary.results) {
        if (r.outcome === 'sent') devices.markSent(r.device);
        else if (r.outcome === 'disable') devices.disable(r.device, r.reason);
        else devices.markFailed(r.device, r.reason);
      }
    })();

    const { lastInsertRowid } = insert.run({
      ...message,
      total: summary.total,
      sent: summary.sent,
      failed: summary.failed,
      disabled: summary.disabled,
      errors: Object.keys(summary.errors).length ? JSON.stringify(summary.errors) : null,
      createdBy: userId,
    });
    return { id: Number(lastInsertRowid), summary };
  }

  /**
   * A push from the game itself (rank changes) to some phones, not recorded in the
   * panel's history. Quietly nothing when APNs is not set up or no phone can receive it.
   */
  async function sendToDevices(deviceIds, { title, body }) {
    const keys = credentials.load();
    if (!keys) return null;
    const targets = deviceIds.map((id) => devices.get(id)).filter((d) => d?.enabled);
    if (!targets.length) return null;
    const summary = await sender.send({ credentials: keys, devices: targets, payload: buildPayload({ title, body }) });
    db.transaction(() => {
      for (const r of summary.results) {
        if (r.outcome === 'sent') devices.markSent(r.device);
        else if (r.outcome === 'disable') devices.disable(r.device, r.reason);
        else devices.markFailed(r.device, r.reason);
      }
    })();
    return summary;
  }

  function history(limit = 50) {
    return db.prepare(`SELECT n.*, u.username FROM notifications n LEFT JOIN users u ON u.id = n.created_by
      ORDER BY n.id DESC LIMIT ?`).all(limit).map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      level: row.level,
      target: row.target,
      device: row.device,
      total: row.total,
      sent: row.sent,
      failed: row.failed,
      disabled: row.disabled,
      errors: row.errors ? JSON.parse(row.errors) : {},
      createdBy: row.username,
      createdAt: row.created_at,
    }));
  }

  return { audience, send, sendToDevices, history };
}
