import { newProjectsEmail, deadlineEmail, newAwardsEmail } from './templates.js'
import { deadlineStatus, SOON_DAYS } from '../utils/deadline.js'
import { nowIso } from '../utils/dates.js'
import { logger } from '../utils/logger.js'

const log = logger.child('[alerts]')
const MAX_ROWS_PER_ALERT = 40

/**
 * Turns saved searches and tracked deadlines into alerts.
 *
 * Two rules shape this:
 *
 *  - **A high-water mark, not a time window.** Each search remembers the instant
 *    it was last considered and only reports rows first seen after it. A window
 *    ("everything from the last 24h") double-sends when a run is late and skips
 *    when one is missed, and this crawler's schedule is not guaranteed.
 *  - **Record first, deliver second.** The notification row is written before
 *    anything is sent, so a mail server that is down loses nothing; delivery is
 *    a status on the row.
 */
export function createAlertService({ savedSearches, notifications, consultations, results, favorites, users, mailer, baseUrl }) {
  /**
   * @returns {Promise<{searches: number, alerts: number, delivered: number, failed: number}>}
   */
  async function run({ now = new Date() } = {}) {
    const stats = { searches: 0, alerts: 0, delivered: 0, failed: 0 }
    // The window closes at the instant the run started, and the cursor moves to
    // exactly that. Half-open on the left, closed on the right: a row created
    // while the run is in flight belongs to the next one, and no row can fall
    // between two runs or be reported by both.
    const cursor = nowIso()

    for (const search of await savedSearches.listActive()) {
      stats.searches += 1
      const filters = safeParse(search.filters_json) ?? {}
      const since = search.last_seen_cursor ?? search.created_at

      if (search.notify_new) {
        const rows = await matchingConsultations(filters, since, cursor)
        if (rows.length > 0) {
          await queue(search, 'new_projects', newProjectsEmail({ search, rows, baseUrl }), rows, stats)
        }
      }

      if (search.notify_awards) {
        const rows = await matchingAwards(filters, since, cursor)
        if (rows.length > 0) {
          await queue(search, 'new_awards', newAwardsEmail({ search, rows, baseUrl }), rows, stats)
        }
      }

      await savedSearches.update(search.id, { last_seen_cursor: cursor })
    }

    await deadlineReminders(now, stats)
    await deliverPending(stats)

    log.info('alert run complete', stats)
    return stats
  }

  /** Rows this instance first saw after the search last looked. */
  async function matchingConsultations(filters, since, until) {
    const { rows } = await consultations.search(
      { ...filters, firstSeenAfter: since, firstSeenBefore: until },
      { limit: MAX_ROWS_PER_ALERT, offset: 0 },
    )
    return rows
  }

  async function matchingAwards(filters, since, until) {
    const { rows } = await results.search(
      { ...filters, firstSeenAfter: since, firstSeenBefore: until },
      { limit: MAX_ROWS_PER_ALERT, offset: 0 },
    )
    return rows.map((row) => ({ ...row, montant_attribue: row.montant_attribue_cents / 100 }))
  }

  /**
   * One reminder per user for everything they track that closes soon.
   *
   * Deadlines here are commonly one to three weeks, and a tracked project that
   * closes unnoticed is the single failure that costs money.
   */
  async function deadlineReminders(now, stats) {
    for (const user of await users.listAll()) {
      if (!user.is_active) continue

      const { rows } = await favorites.listForUser(user.id, {}, { limit: 200, offset: 0 })
      const closing = rows
        .map((row) => ({ ...row, deadline: deadlineStatus(row.date_limite, row.heure_limite ?? null, now) }))
        // Still open, and closing inside the window. Measured in hours because
        // an avis closing at 10:00 has already gone by the afternoon, and
        // reminding somebody about it is worse than saying nothing.
        .filter((row) => row.deadline && row.deadline.hours > 0 && row.deadline.days <= SOON_DAYS)

      if (closing.length === 0) continue

      // Once a day at most, however often this runs.
      const alreadyToday = (await notifications.listForUser(user.id, 20)).some(
        (row) => row.kind === 'deadline' && row.created_at.slice(0, 10) === nowIso().slice(0, 10),
      )
      if (alreadyToday) continue

      const email = deadlineEmail({ rows: closing, baseUrl })
      await notifications.create({
        user_id: user.id,
        saved_search_id: null,
        kind: 'deadline',
        subject: email.subject,
        body: email.text,
        payload_json: JSON.stringify({ html: email.html, to: user.email, ids: closing.map((r) => r.id) }),
        channel: (await mailer.isConfigured()) ? 'email' : 'log',
      })
      stats.alerts += 1
    }
  }

  async function queue(search, kind, email, rows, stats) {
    await notifications.create({
      user_id: search.user_id,
      saved_search_id: search.id,
      kind,
      subject: email.subject,
      body: email.text,
      payload_json: JSON.stringify({ html: email.html, to: search.email, ids: rows.map((row) => row.id) }),
      channel: (await mailer.isConfigured()) ? 'email' : 'log',
    })
    await savedSearches.update(search.id, { last_notified_at: nowIso() })
    stats.alerts += 1
  }

  /** Sends what is queued. A failure stays on the row for the next attempt. */
  async function deliverPending(stats) {
    for (const notification of await notifications.listPending()) {
      const payload = safeParse(notification.payload_json) ?? {}
      try {
        await mailer.send({
          to: payload.to,
          subject: notification.subject,
          text: notification.body,
          html: payload.html,
        })
        await notifications.markSent(notification.id)
        stats.delivered += 1
      } catch (error) {
        await notifications.markFailed(notification.id, error.message)
        stats.failed += 1
        log.error('delivery failed', { id: notification.id, message: error.message })
      }
    }
  }

  const safeParse = (value) => {
    try {
      return value ? JSON.parse(value) : null
    } catch {
      return null
    }
  }

  return { run, deliverPending }
}
