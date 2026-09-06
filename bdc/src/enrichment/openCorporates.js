import { logger } from '../utils/logger.js'

const log = logger.child('[enrich:opencorporates]')

const ENDPOINT = 'https://api.opencorporates.com/v0.4/companies/search'
/** Morocco's jurisdiction code in the OpenCorporates scheme. */
const JURISDICTION = 'ma'
const TIMEOUT_MS = 15_000
const MAX_CANDIDATES = 8

/**
 * Looking a company up in a public register.
 *
 * OpenCorporates is the only one of the three obvious sources that can be used
 * lawfully by a program. OMPIC's own site refuses connections from outside its
 * network, and its commercial data is sold through DirectInfo, which is a paid
 * subscription with no API and no redistribution terms. OpenCorporates'
 * robots.txt disallows /search and /officers outright, so its website is not an
 * option either — but it publishes an API, and this uses that.
 *
 * The API needs a token. Without one this reports itself unconfigured and the
 * panel shows the lookup disabled, the same way translation does, rather than
 * failing at the moment somebody clicks.
 *
 * It never writes. Matching 5,000 Moroccan company names to a register by name
 * alone is a guess — the award data carries no ICE to join on — so this returns
 * candidates for a person to choose between. Writing an unreviewed match would
 * put a confidently wrong ICE on a profile, which is worse than an empty one.
 */
export function createCompanyLookup(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const resolve = options.resolve ?? (async () => ({ apiToken: options.apiToken ?? '' }))

  const current = async () => {
    const resolved = await resolve()
    const apiToken = String(resolved?.apiToken ?? '').trim()
    return { apiToken, enabled: options.enabled ?? Boolean(apiToken) }
  }

  const isConfigured = async () => (await current()).enabled

  /**
   * @param {string} name the company as the portal prints it.
   * @returns {Promise<{configured: boolean, candidates: Array<object>, error: string|null}>}
   */
  async function search(name) {
    const { apiToken, enabled } = await current()
    if (!enabled) return { configured: false, candidates: [], error: null }
    const query = String(name ?? '').trim()
    if (!query) return { configured: true, candidates: [], error: null }

    const url = new URL(ENDPOINT)
    url.searchParams.set('q', query)
    url.searchParams.set('jurisdiction_code', JURISDICTION)
    url.searchParams.set('per_page', String(MAX_CANDIDATES))
    url.searchParams.set('api_token', apiToken)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
      if (!response.ok) {
        // 401 means the token is wrong or expired, 403 that the plan does not
        // cover this call. Both are worth reading rather than "lookup failed".
        const detail = response.status === 401 ? 'the API token was refused'
          : response.status === 403 ? 'this API token does not cover company search'
          : response.status === 429 ? 'the API rate limit was reached'
          : `the API answered ${response.status}`
        log.warn('lookup refused', { status: response.status, name: query })
        return { configured: true, candidates: [], error: detail }
      }
      const body = await response.json()
      const companies = body?.results?.companies ?? []
      return { configured: true, candidates: companies.map((entry) => shape(entry.company)).filter(Boolean), error: null }
    } catch (error) {
      const reason = error.name === 'AbortError' ? 'the register did not answer in time' : error.message
      log.warn('lookup failed', { name: query, reason })
      return { configured: true, candidates: [], error: reason }
    } finally {
      clearTimeout(timer)
    }
  }

  return { search, isConfigured, source: 'opencorporates' }
}

/** The subset worth showing, in this application's own field names. */
function shape(company) {
  if (!company?.name) return null
  return {
    name: company.name,
    registryNumber: company.company_number ?? null,
    legalForm: company.company_type ?? null,
    status: company.current_status ?? null,
    address: company.registered_address_in_full ?? null,
    incorporatedOn: company.incorporation_date ?? null,
    sourceUrl: company.opencorporates_url ?? null,
  }
}
