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
  return clean(value)
    .toUpperCase()
    .replace(/[\s._]+/g, '')
    .replace(/[^A-Z0-9/-]/g, '')
    // Some avis are published with a leading separator — "/69/2026/ISTAHTT" is
    // real portal data. Keeping it in the join key would mean the award for the
    // same avis, published as "69/2026/ISTAHTT", never matched it.
    .replace(/^[/-]+/, '')
    .replace(/[/-]+$/, '')
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

/**
 * The key that identifies the same avis across the two listings.
 *
 * A reference alone is not an identity: "07/2026" appears three times on five
 * pages of the portal, once per commune, because each buyer numbers its own
 * avis. Consultations are therefore keyed on the portal's own id, and the pair
 * (reference, buyer) is what links an award back to its consultation — the only
 * signal the results listing gives, since it carries no id and no detail link.
 */
export function matchKey(reference, acheteur) {
  const ref = normalizeReference(reference)
  const buyer = normalize(acheteur).replace(/[^a-z0-9]+/g, '')
  return ref && buyer ? `${ref}|${buyer}` : null
}
