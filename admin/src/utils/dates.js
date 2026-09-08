import { clean } from './text.js'

const DMY = /(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})/
const YMD = /(\d{4})-(\d{2})-(\d{2})/
const TIME = /(\d{1,2})\s*[:h]\s*(\d{2})/

const pad = (value) => String(value).padStart(2, '0')

/**
 * Parses the date formats used by marchespublics.gov.ma ("12/05/2025",
 * "12/05/2025 10:30", "12/05/2025 a 10 h 30") into an ISO-8601 date string.
 * All dates are stored as TEXT so ordering and range filters behave identically
 * on SQLite and PostgreSQL.
 * @returns {string|null} "YYYY-MM-DD" or null when unparseable.
 */
export function parseDate(value) {
  const text = clean(value)
  if (!text) return null

  const ymd = text.match(YMD)
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`

  const dmy = text.match(DMY)
  if (!dmy) return null

  const [, day, month, year] = dmy
  const monthNum = Number(month)
  const dayNum = Number(day)
  if (monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > 31) return null
  return `${year}-${pad(month)}-${pad(day)}`
}

/** @returns {string|null} "HH:MM" extracted from a date/time cell. */
export function parseTime(value) {
  const match = clean(value).match(TIME)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return `${pad(hours)}:${pad(minutes)}`
}

/** @returns {string|null} "YYYY-MM-DDTHH:MM:00" when both parts are present. */
export function parseDateTime(value) {
  const date = parseDate(value)
  if (!date) return null
  const time = parseTime(value)
  return time ? `${date}T${time}:00` : date
}

/** Current instant as an ISO-8601 UTC string — the canonical timestamp format. */
export function nowIso() {
  return new Date().toISOString()
}

/** Validates a "YYYY-MM-DD" filter value coming from the query string. */
export function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
}
