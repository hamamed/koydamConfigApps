const NON_BREAKING_SPACE = / /g
const WHITESPACE_RUN = /\s+/g
const DIACRITICS = /[̀-ͯ]/g

/** Collapses whitespace, strips non-breaking spaces and trims. Returns '' for nullish input. */
export function clean(value) {
  if (value === null || value === undefined) return ''
  return String(value).replace(NON_BREAKING_SPACE, ' ').replace(WHITESPACE_RUN, ' ').trim()
}

/** Like {@link clean} but returns null instead of an empty string, for nullable DB columns. */
export function cleanOrNull(value) {
  const cleaned = clean(value)
  return cleaned === '' ? null : cleaned
}

/** Lowercase, accent-free form used for fuzzy comparisons and search keys. */
export function normalize(value) {
  return clean(value).normalize('NFD').replace(DIACRITICS, '').toLowerCase()
}

/**
 * Canonical form of a consultation reference, used as the join key between
 * consultations and their results. Removes spacing/punctuation noise so that
 * "123/2025 " and "123 / 2025" resolve to the same key.
 */
export function normalizeReference(value) {
  return clean(value).toUpperCase().replace(/[\s._]+/g, '').replace(/[^A-Z0-9/-]/g, '')
}

/** Extracts the first reference-looking token from a free text blob. */
export function extractReference(value) {
  const match = clean(value).match(/([A-Z0-9][A-Z0-9._/-]{3,})/i)
  return match ? normalizeReference(match[1]) : null
}

/**
 * Splits "Label : value" text into a [label, value] pair.
 *
 * Colons inside a time are skipped: the portal prints deadlines as
 * "Date limite de réception des devis 02/10/2026 15:00", and splitting on the
 * colon in "15:00" yields the label "…devis 02/10/2026 15" and the value "00".
 * That silently produced an unparseable date rather than an obvious error.
 */
export function splitLabelled(value) {
  const cleaned = clean(value)
  for (let index = cleaned.indexOf(':'); index !== -1; index = cleaned.indexOf(':', index + 1)) {
    const isTime = /\d/.test(cleaned[index - 1] ?? '') && /\d/.test(cleaned[index + 1] ?? '')
    if (isTime) continue
    return [cleaned.slice(0, index).trim(), cleaned.slice(index + 1).trim()]
  }
  return [null, cleaned]
}
