/**
 * How long is left before an avis closes.
 *
 * Deadlines here are short and they have an hour. The median window between
 * publication and closing is four days, 93% of what is open closes inside two,
 * and 385 of 704 close before noon — so a badge computed in whole days told a
 * bidder "closes today" for five hours after the thing had shut. Time is the
 * whole point of this application; ignoring the clock was the most harmful
 * inaccuracy in it.
 *
 * Everything is computed against the real closing instant, which is a wall
 * time in Morocco. The zone matters: the server runs UTC, Morocco is normally
 * UTC+1, and it drops to UTC for Ramadan — so the offset is asked for at the
 * instant in question rather than assumed.
 */
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 24 * MS_PER_HOUR

/** Where the portal's clock is. */
export const PORTAL_TIMEZONE = 'Africa/Casablanca'

export const URGENCY = Object.freeze({ PASSED: 'passed', HOURS: 'hours', TODAY: 'today', SOON: 'soon', OPEN: 'open' })

/** Below this many days remaining, a deadline is worth flagging. */
export const SOON_DAYS = 3
/** Below this many hours, say the hours: "closes in 4h" is a different message. */
export const HOURS_THRESHOLD = 24

/** With no hour published, assume the end of the day rather than the start. */
const DEFAULT_CLOSING_TIME = '23:59'

/**
 * The instant an avis closes, as a UTC timestamp.
 *
 * @param {string} date `YYYY-MM-DD`.
 * @param {string|null} time `HH:mm` or `HH:mm:ss`, read as Morocco wall time.
 * @returns {number|null} milliseconds since the epoch.
 */
export function closingInstant(date, time = null) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const clock = /^\d{2}:\d{2}/.test(String(time ?? '')) ? String(time).slice(0, 5) : DEFAULT_CLOSING_TIME

  // Read the wall time as if it were UTC, then correct by the zone's offset at
  // that moment. Applied twice because the first correction can land on the
  // other side of a change in offset.
  const naive = Date.parse(`${date}T${clock}:00Z`)
  if (Number.isNaN(naive)) return null
  let instant = naive - zoneOffset(naive)
  instant = naive - zoneOffset(instant)
  return instant
}

/**
 * @param {string|null} date ISO date, `YYYY-MM-DD`.
 * @param {string|null} time `HH:mm`, the hour the portal publishes.
 * @param {Date} [now]
 * @returns {{days:number, hours:number, urgency:string, closesAt:string}|null}
 *   null when there is no usable deadline.
 */
export function deadlineStatus(date, time = null, now = new Date()) {
  const closes = closingInstant(date, time)
  if (closes === null) return null

  const remaining = closes - now.getTime()
  const hours = Math.floor(remaining / MS_PER_HOUR)
  // Calendar days apart, so "closes tomorrow" reads as 1 whatever the hour.
  const days = Math.floor(remaining / MS_PER_DAY)

  const urgency =
    remaining <= 0 ? URGENCY.PASSED
    : hours < HOURS_THRESHOLD ? URGENCY.HOURS
    : days === 0 ? URGENCY.TODAY
    : days <= SOON_DAYS ? URGENCY.SOON
    : URGENCY.OPEN

  return { days, hours, urgency, closesAt: new Date(closes).toISOString() }
}

/** Offset of the portal's zone, in ms, at a given instant. */
function zoneOffset(instant) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: PORTAL_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant))

  const at = (type) => Number(parts.find((part) => part.type === type)?.value)
  const asUtc = Date.UTC(at('year'), at('month') - 1, at('day'), at('hour'), at('minute'), at('second'))
  return asUtc - instant
}
