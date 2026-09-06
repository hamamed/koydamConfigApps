/**
 * How long is left before an avis closes.
 *
 * Deadlines on this portal are short — commonly one to three weeks — so "closes
 * in 2 days" is the single most useful thing to put next to a project. Whole
 * days in UTC, matching how the dates are stored.
 */
const MS_PER_DAY = 86_400_000

export const URGENCY = Object.freeze({ PASSED: 'passed', TODAY: 'today', SOON: 'soon', OPEN: 'open' })

/** Below this many days remaining, a deadline is worth flagging. */
export const SOON_DAYS = 3

/**
 * @param {string|null} deadline ISO date, `YYYY-MM-DD`.
 * @returns {{days: number, urgency: string}|null} null when there is no deadline.
 */
export function deadlineStatus(deadline, today = new Date()) {
  if (!deadline || !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return null

  const closes = Date.parse(`${deadline}T00:00:00Z`)
  if (Number.isNaN(closes)) return null

  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  const days = Math.round((closes - midnight) / MS_PER_DAY)

  if (days < 0) return { days, urgency: URGENCY.PASSED }
  if (days === 0) return { days, urgency: URGENCY.TODAY }
  if (days <= SOON_DAYS) return { days, urgency: URGENCY.SOON }
  return { days, urgency: URGENCY.OPEN }
}
