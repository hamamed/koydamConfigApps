import { fromCentimes } from '../utils/money.js'
import { matchName } from '../repositories/exclusionRepository.js'
import { searchTerms } from '../repositories/search.js'
import { clean, normalize } from '../utils/text.js'

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

  async function list({ q = '', filter = '', city = '', page = 1, perPage = 40 } = {}) {
    const [rows, register, excluded, recorded] = await Promise.all([
      analytics.companyDirectory(),
      // Kept as a map rather than a set of keys: the register is also where a
      // city comes from, and a company's town is the most useful thing on this
      // screen after what it has won — bidders work regions.
      registerOf(btp.listAll(20_000)),
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
        city: register.get(key)?.ville ?? null,
        qualified: register.has(key),
        excluded: excluded.has(key),
        recorded: recorded.has(key),
      }
      // "Known" means we can say where it is: an address from the BTP register,
      // or something an administrator recorded and confirmed.
      entry.known = entry.qualified || entry.recorded
      return entry
    })

    const wantedCity = clean(city)
    const matched = companies
      .filter((entry) => terms.every((term) => normalize(entry.name).includes(term)))
      .filter((entry) => !wantedCity || entry.city === wantedCity)
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
      // Only the towns these companies are actually in. Offering all 68 in the
      // register would be mostly options that match nothing here.
      cities: townsOf(companies),
      page: Math.max(1, page),
      perPage,
    }
  }

  return { list }
}

/** Towns present among these companies, commonest first. */
function townsOf(companies) {
  const counts = new Map()
  for (const entry of companies) {
    if (entry.city) counts.set(entry.city, (counts.get(entry.city) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([label, total]) => ({ label, total }))
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label))
}

/** The register, keyed by normalised name — one entry per company. */
async function registerOf(promise) {
  const map = new Map()
  for (const row of await promise) {
    if (!map.has(row.match_name)) map.set(row.match_name, row)
  }
  return map
}

/** The set of normalised names a register knows about. */
async function keysOf(promise, column, normaliseValue = false) {
  const rows = await promise
  return new Set(rows.map((row) => (normaliseValue ? matchName(row[column]) : row[column])))
}
