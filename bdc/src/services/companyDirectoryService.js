import { fromCentimes } from '../utils/money.js'
import { matchName } from '../repositories/exclusionRepository.js'
import { searchTerms } from '../repositories/search.js'
import { normalize } from '../utils/text.js'

/**
 * Every company that has won public work, and what is known about each beyond
 * its name.
 *
 * The point of this screen is coverage: the portal publishes no ICE, no address
 * and no register number on an award, so most of these companies are a name and
 * nothing else. Being able to see *which* ones — and to search the ones that are
 * enriched — is what makes the identity work reviewable rather than a claim.
 *
 * The join happens in memory because the registers are keyed on a normalised
 * name that exists only in JavaScript. Nine thousand rows is small enough that
 * this is a simpler and more honest answer than storing a derived key on every
 * one of ~76,000 award rows and keeping it in step.
 */
export function createCompanyDirectoryService({ analytics, btp, exclusions, companyRecords }) {
  const FILTERS = new Set(['known', 'unknown', 'excluded', 'qualified'])

  async function list({ q = '', filter = '', page = 1, perPage = 40 } = {}) {
    const [rows, qualified, excluded, recorded] = await Promise.all([
      analytics.companyDirectory(),
      keysOf(btp.listAll(20_000), 'match_name'),
      keysOf(exclusions.listAll(20_000), 'match_name'),
      keysOf(companyRecords.listVerified(20_000), 'name', true),
    ])

    const terms = searchTerms(q)
    const wanted = FILTERS.has(filter) ? filter : ''

    const companies = rows.map((row) => {
      const key = matchName(row.name)
      const entry = {
        name: row.name,
        awards: Number(row.awards),
        total: fromCentimes(Number(row.total_cents ?? 0)),
        buyers: Number(row.buyers),
        lastAward: row.last_award ?? null,
        qualified: qualified.has(key),
        excluded: excluded.has(key),
        recorded: recorded.has(key),
      }
      // "Known" means we can say where it is: an address from the BTP register,
      // or something an administrator recorded and confirmed.
      entry.known = entry.qualified || entry.recorded
      return entry
    })

    const matched = companies
      .filter((entry) => terms.every((term) => normalize(entry.name).includes(term)))
      .filter((entry) =>
        wanted === 'known' ? entry.known
        : wanted === 'unknown' ? !entry.known
        : wanted === 'excluded' ? entry.excluded
        : wanted === 'qualified' ? entry.qualified
        : true)
      .sort((a, b) => b.awards - a.awards || a.name.localeCompare(b.name))

    const start = (Math.max(1, page) - 1) * perPage
    return {
      rows: matched.slice(start, start + perPage),
      total: matched.length,
      summary: {
        companies: companies.length,
        known: companies.filter((c) => c.known).length,
        qualified: companies.filter((c) => c.qualified).length,
        excluded: companies.filter((c) => c.excluded).length,
      },
      page: Math.max(1, page),
      perPage,
    }
  }

  return { list }
}

/** The set of normalised names a register knows about. */
async function keysOf(promise, column, normaliseValue = false) {
  const rows = await promise
  return new Set(rows.map((row) => (normaliseValue ? matchName(row[column]) : row[column])))
}
