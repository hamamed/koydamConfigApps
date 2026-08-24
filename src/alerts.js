import { query } from './db/pool.js';
import { log } from './log.js';

/**
 * Tells someone when a service changes state.
 *
 * The health monitor has been writing check results to a table every minute
 * and notifying nobody, so an outage at 3am was discovered by opening the
 * dashboard the next morning.
 *
 * ## On a change, not on a state
 *
 * A service that stays down is one message, not one a minute. The previous
 * status is remembered per service and a notification is sent only when it
 * differs - which also means recovery is announced, and a night of alerts
 * cannot bury the one that mattered.
 */

/** How long to wait on a destination. Long enough for a slow webhook, short
 *  enough that a hung one cannot stall the health sweep behind it. */
const TIMEOUT_MS = 6000;

/**
 * Destinations, secrets included - callers are server-side only.
 *
 * Nothing returns `target` to a browser: for Telegram it is a bot token, and a
 * dashboard that displays it once has leaked it to every screenshot after.
 */
async function targets() {
  const res = await query(
    'SELECT id, kind, target, chat_id FROM alert_targets WHERE enabled',
  );
  return res?.rows ?? [];
}

async function post(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return null;
  } catch (err) {
    return err.message;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends one message to every enabled destination.
 *
 * Failures are recorded against the destination rather than thrown: one dead
 * webhook must not stop the others being told, and must not fail the health
 * sweep that called this.
 */
export async function notify(text) {
  const rows = await targets();
  if (!rows.length) return 0;

  let sent = 0;

  for (const t of rows) {
    let error = null;

    if (t.kind === 'telegram') {
      if (!t.chat_id) {
        error = 'no chat_id configured';
      } else {
        error = await post(`https://api.telegram.org/bot${t.target}/sendMessage`, {
          chat_id: t.chat_id,
          text,
          disable_web_page_preview: true,
        });
      }
    } else {
      // A generic webhook. `text` is what Slack and Discord both read, so one
      // shape covers the two most likely destinations without a per-service
      // adapter.
      error = await post(t.target, { text, content: text });
    }

    if (error) {
      log.warn('Alert delivery failed', { id: t.id, kind: t.kind, error });
    } else {
      sent += 1;
    }

    await query(
      'UPDATE alert_targets SET last_sent_at = now(), last_error = $2 WHERE id = $1',
      [t.id, error],
    ).catch(() => {});
  }

  return sent;
}

/**
 * Compares each service against what it was last seen as, and announces the
 * ones that changed.
 *
 * `checks` is what checkAllServices() returned: `{ slug, name, ok, status }`.
 */
export async function reportStatusChanges(checks) {
  if (!Array.isArray(checks) || !checks.length) return;

  const previous = await query('SELECT service_slug, last_status FROM service_alert_state');
  const was = new Map((previous?.rows ?? []).map((r) => [r.service_slug, r.last_status]));

  const changes = [];

  for (const c of checks) {
    const slug = c.slug ?? c.service_slug;
    if (!slug) continue;

    const now = c.ok ? 'up' : 'down';
    const before = was.get(slug);

    // First sighting is recorded, not announced. Otherwise every service
    // reports itself on the first boot after this ships, which trains whoever
    // receives it to ignore the channel.
    if (before === undefined) {
      await query(
        `INSERT INTO service_alert_state (service_slug, last_status)
         VALUES ($1, $2)
         ON CONFLICT (service_slug) DO UPDATE SET last_status = EXCLUDED.last_status`,
        [slug, now],
      );
      continue;
    }

    if (before === now) continue;

    changes.push({ slug, name: c.name ?? slug, now, detail: c.status });

    await query(
      `UPDATE service_alert_state
          SET last_status = $2, changed_at = now(), notified_at = now()
        WHERE service_slug = $1`,
      [slug, now],
    );
  }

  if (!changes.length) return;

  // One message for the batch. A deploy restarts three services at once, and
  // three separate alerts for one intended action is noise.
  const lines = changes.map((c) =>
    c.now === 'down'
      ? `DOWN  ${c.name}${c.detail ? ` (${c.detail})` : ''}`
      : `UP    ${c.name}`,
  );

  const anyDown = changes.some((c) => c.now === 'down');
  const text =
    `${anyDown ? '⚠️' : '✅'} hamaprojects\n\n${lines.join('\n')}`;

  const sent = await notify(text);
  log.info('Service status change', { changes: changes.length, delivered: sent });
}
