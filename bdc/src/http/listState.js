/**
 * Where the reader was, so that coming back is not starting over.
 *
 * The listing screen carries its whole state in the query string — filters,
 * sort, page. Following a consultation and pressing Back used to land on a
 * bare `/panel`, throwing away a search that may have taken a dozen keystrokes
 * to arrive at. This keeps the last listing the reader actually saw and hands
 * it back to the two links that lead there: the detail screen's Back, and the
 * sidebar.
 *
 * It lives in a cookie rather than a table because it is a convenience, not a
 * record: it should follow the browser, expire on its own, and never be worth
 * a migration. It is read back through the same whitelist it was written with,
 * so a hand-edited cookie can only ever produce a listing URL.
 */
const COOKIE = 'mp_list'
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const MAX_VALUE_LENGTH = 200

/** The query keys the listing screen owns. Anything else is not remembered. */
const KEYS = Object.freeze([
  'q', 'reference', 'acheteur', 'categorie', 'lieuExecution',
  'datePublicationStart', 'datePublicationEnd', 'dateLimiteStart', 'dateLimiteEnd',
  'closingWithin', 'status', 'sort', 'page',
])

/** @returns {string} a query string of the keys worth remembering, or ''. */
function canonical(query = {}) {
  const params = new URLSearchParams()
  KEYS.forEach((key) => {
    const value = query[key]
    if (typeof value !== 'string') return
    const clean = value.trim()
    // `status=all` and `page=1` are the defaults; storing them would make an
    // untouched listing look like a remembered one.
    if (!clean || clean.length > MAX_VALUE_LENGTH) return
    if (key === 'page' && !/^[1-9]\d{0,5}$/.test(clean)) return
    if (key === 'page' && clean === '1') return
    if (key === 'status' && clean === 'all') return
    params.set(key, clean)
  })
  return params.toString()
}

/** Stores the listing the reader is looking at. An empty listing clears it. */
export function rememberList(res, query, { isProduction = false } = {}) {
  const value = canonical(query)
  if (!value) {
    res.clearCookie(COOKIE, { path: '/' })
    return
  }
  res.cookie(COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: MAX_AGE_MS,
    path: '/',
  })
}

/** Forgets it, for the reader who asked for a clean listing. */
export function forgetList(res) {
  res.clearCookie(COOKIE, { path: '/' })
}

/**
 * @returns {string} the listing URL to return to: `/panel`, carrying the
 *   remembered state when there is any and nothing when there is not.
 *
 * No `lang` is added. The chosen language already rides in its own cookie —
 * which is why every other link in the sidebar is a bare path — and putting it
 * back here would make an untouched listing a different URL from `/panel`.
 */
export function listUrl(req) {
  const query = canonical(
    Object.fromEntries(new URLSearchParams(req.cookies?.[COOKIE] ?? '')),
  )
  return query ? `/panel?${query}` : '/panel'
}
