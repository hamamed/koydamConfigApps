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

/** Splits "Label : value" cells into a [label, value] pair. */
export function splitLabelled(value) {
  const cleaned = clean(value)
  const index = cleaned.indexOf(':')
  if (index === -1) return [null, cleaned]
  return [cleaned.slice(0, index).trim(), cleaned.slice(index + 1).trim()]
}
