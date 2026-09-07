import test from 'node:test'
import assert from 'node:assert/strict'
import { parseBtpList } from '../src/scraper/parsers/btpParser.js'
import { createBtpScraper } from '../src/scraper/btpScraper.js'
import { createHttpClient } from '../src/scraper/httpClient.js'
import { createTestContainer, fixture } from './helpers.js'

const PAGE = fixture('live-btp-qualifiees.html')

test('the BTP register yields the fields an award row never carries', () => {
  const { items, total, pager } = parseBtpList(PAGE, 'https://www.equipement.gov.ma/x')

  assert.equal(items.length, 10)
  assert.equal(total, 4911, 'the register states its own size')

  // Trade register, street address, city and telephone: the ICE is empty on
  // every one of ~76,000 award rows, so none of this exists anywhere else free.
  assert.deepEqual(items[0], {
    raison_sociale: 'SOCIÉTÉ KHALIJ NEKOR',
    registre_commerce: '289',
    ville: 'AL HOCEIMA',
    adresse: 'RUE CASABLANCA N° 100, IMZOUREN',
    telephone: '0539806078',
    fax: '0539805585',
    code: 'AH/30',
    source_url: 'https://www.equipement.gov.ma/x',
  })
  assert.ok(items.every((row) => row.raison_sociale && row.registre_commerce))

  // The pager is keyed by the page number it shows, because the window of
  // numbers slides as you advance and "the third link" stops meaning page 3.
  assert.deepEqual(Object.keys(pager.pages).sort(), ['2', '3', '4', '5'])
  assert.match(pager.pages['2'], /DataPager1/)
  // And the "…" that reaches the next group. Without it the crawl stops at the
  // first group boundary, having collected fifty of 4,911 companies.
  assert.ok(pager.more, 'the next-group link is kept')
  assert.match(pager.more, /DataPager1/)
})

test('the search posts click coordinates, because the button is an image', async (t) => {
  const container = await createTestContainer()
  t.after(() => container.db.close?.())

  const posts = []
  const http = createHttpClient({
    delayMs: 0,
    fetchImpl: async (url, init = {}) => {
      if (init.method === 'POST') posts.push(new URLSearchParams(init.body))
      return { ok: true, status: 200, url: String(url), headers: { getSetCookie: () => [] }, text: async () => PAGE }
    },
  })

  const scraper = createBtpScraper({ http, btp: container.repositories.btp })
  const stats = await scraper.scrape({ startPage: 1, pages: 1 })

  assert.equal(stats.itemsFound, 10)
  assert.equal(stats.itemsCreated, 10)
  assert.equal(stats.total, 4911)
  assert.equal(stats.lastPage, 492, '4,911 rows at ten a page')

  const [search] = posts
  // An <input type="image"> submits its click coordinates. Posting name=value
  // instead returns the untouched form, which looks exactly like "no results".
  assert.ok([...search.keys()].some((k) => k.endsWith('Rech_Btn.x')), 'the button is clicked, not set')
  assert.ok(!search.has('ctl00$ctl36$g_c22810fe_535a_45e2_9941_38d174e62f90$ctl00$Rech_Btn'))

  // Eleven criteria controls share one name and are read back as an ordered
  // list; joined with commas they would submit one meaningless value.
  const criteria = search.getAll('ctl00$ctl36$g_c22810fe_535a_45e2_9941_38d174e62f90$ctl00$D4')
  assert.equal(criteria.length, 11)
  assert.equal(criteria[0], 'Liste des secteurs')
  assert.equal(criteria[10], 'Toutes les Villes')

  assert.ok(search.get('__VIEWSTATE'), 'the view state is carried back')
})

test('paging follows the link labelled with the page it wants', async (t) => {
  const container = await createTestContainer()
  t.after(() => container.db.close?.())

  const targets = []
  const http = createHttpClient({
    delayMs: 0,
    fetchImpl: async (url, init = {}) => {
      if (init.method === 'POST') {
        const target = new URLSearchParams(init.body).get('__EVENTTARGET')
        if (target) targets.push(target)
      }
      return { ok: true, status: 200, url: String(url), headers: { getSetCookie: () => [] }, text: async () => PAGE }
    },
  })

  const scraper = createBtpScraper({ http, btp: container.repositories.btp })
  await scraper.scrape({ startPage: 1, pages: 3 })

  const paged = targets.filter(Boolean)
  assert.equal(paged.length, 2, 'two page turns for three pages')
  assert.ok(paged.every((t) => t.includes('DataPager1')))

  // The fixture is one page repeated, so re-reading it changes nothing.
  assert.equal(await container.repositories.btp.countAll(), 10)
})

test('a company is found under the spelling the other registers use', async (t) => {
  const container = await createTestContainer()
  t.after(() => container.db.close?.())

  await container.repositories.btp.upsert({
    raison_sociale: 'SOCIETE KHALIJ NEKOR SARL', registre_commerce: '289',
    ville: 'AL HOCEIMA', adresse: 'RUE CASABLANCA N° 100', telephone: '0539806078',
  })

  // Same normalisation as the exclusion register, so a business is found under
  // one key wherever it appears.
  const found = await container.repositories.btp.findForCompany('Ste Khalij Nekor')
  assert.equal(found.length, 1)
  assert.equal(found[0].registre_commerce, '289')

  // Two companies sharing a trading name are told apart by the register number.
  await container.repositories.btp.upsert({ raison_sociale: 'KHALIJ NEKOR', registre_commerce: '999', ville: 'RABAT' })
  assert.equal((await container.repositories.btp.findForCompany('KHALIJ NEKOR')).length, 2)
  assert.equal(await container.repositories.btp.countAll(), 2)
})

test('the companies screen shows which companies we know anything about', async (t) => {
  const container = await createTestContainer()
  t.after(() => container.db.close?.())

  const award = (index, attributaire, cents) =>
    container.repositories.results.upsert({
      result_key: `k${index}`, reference: `${index}/2026`, reference_raw: `${index}/2026`,
      match_key: `${index}|x`, objet: 'Achat', acheteur: `COMMUNE ${index}`, attributaire,
      montant_attribue_cents: cents, currency: 'MAD', nombre_offres: 4, result_status: 'attribue',
      date_publication_resultat: '2026-08-01', search_text: 'achat',
      first_seen_at: 'x', last_seen_at: 'x', created_at: 'x', updated_at: 'x',
    })

  await award(1, 'SOCIETE KHALIJ NEKOR SARL', 100000)
  await award(2, 'SOCIETE KHALIJ NEKOR SARL', 300000)
  await award(3, 'ENTREPRISE INCONNUE', 50000)
  await award(4, 'STE BANNIE', 70000)

  // One is in the BTP register, one is excluded, one is nothing but a name.
  await container.repositories.btp.upsert({
    raison_sociale: 'KHALIJ NEKOR', registre_commerce: '289', ville: 'AL HOCEIMA', adresse: 'RUE X',
  })
  await container.repositories.exclusions.upsert({
    raison_sociale: 'BANNIE', entite_publique: 'ONEE', date_debut: '2026-01-01',
  })

  const all = await container.services.companyDirectory.list({})
  assert.equal(all.summary.companies, 3, 'one row per company, not per award')
  assert.equal(all.summary.known, 1, 'only the one with an address counts as known')
  assert.equal(all.summary.excluded, 1)

  const khalij = all.rows.find((r) => r.name.startsWith('SOCIETE KHALIJ'))
  assert.equal(khalij.awards, 2, 'its two awards are counted together')
  assert.equal(khalij.total, 4000)
  assert.equal(khalij.qualified, true)
  assert.equal(khalij.known, true)

  // The registers are matched on the normalised name, so "SOCIETE … SARL" finds
  // the register's "KHALIJ NEKOR" and "STE BANNIE" finds "BANNIE".
  assert.equal(all.rows.find((r) => r.name === 'STE BANNIE').excluded, true)
  assert.equal(all.rows.find((r) => r.name === 'ENTREPRISE INCONNUE').known, false)

  // The filters answer the question the screen exists for.
  assert.deepEqual((await container.services.companyDirectory.list({ filter: 'unknown' }))
    .rows.map((r) => r.name).sort(), ['ENTREPRISE INCONNUE', 'STE BANNIE'])
  assert.deepEqual((await container.services.companyDirectory.list({ filter: 'excluded' }))
    .rows.map((r) => r.name), ['STE BANNIE'])

  // And search narrows without needing the exact spelling.
  const found = await container.services.companyDirectory.list({ q: 'khalij' })
  assert.equal(found.total, 1)
  assert.equal(found.rows[0].name, 'SOCIETE KHALIJ NEKOR SARL')
})

test('an unreachable ministry is reported as unreachable, not as an empty register', async (t) => {
  const container = await createTestContainer()
  t.after(() => container.db.close?.())

  // The ministry filters this project's server at TCP level. Grinding through
  // retries and then reporting nothing would look exactly like "the register is
  // empty today", which is the silent failure this project keeps meeting.
  const http = createHttpClient({
    delayMs: 0, maxRetries: 1,
    fetchImpl: async () => { throw new Error('connect ETIMEDOUT') },
  })
  const scraper = createBtpScraper({ http, btp: container.repositories.btp })

  await assert.rejects(() => scraper.scrape({ pages: 1 }), (error) => {
    assert.match(error.message, /cannot reach https:\/\/www\.equipement\.gov\.ma/)
    assert.match(error.message, /export-btp/, 'and points at the way round it')
    return true
  })
  assert.equal(await container.repositories.btp.countAll(), 0)
})
