import test from 'node:test'
import assert from 'node:assert/strict'
import { createCompanyLookup } from '../src/enrichment/openCorporates.js'
import { createTestContainer } from './helpers.js'

const COMPANY = 'STE EXEMPLE SARL'

test('a company record is stored against the name and marked verified by a person', async (t) => {
  const container = await createTestContainer()
  t.after(() => container.db.close?.())
  const admin = await container.services.auth.register({
    email: 'a@t.ma', password: 'a-very-long-password', role: 'admin',
  })
  const reviewer = admin.user ?? admin

  const saved = await container.services.companyRecords.save(COMPANY, {
    ice: '001234567000089', registryNumber: 'RC 12345', legalForm: 'SARL',
    address: '12 rue des Écoles', city: 'Laâyoune', phone: '0600000000',
  }, reviewer)

  assert.equal(saved.ice, '001234567000089')
  assert.equal(saved.city, 'Laâyoune')
  assert.ok(saved.verified_at, 'saving from the panel is the act of confirming it')
  assert.equal(saved.source, 'manual')

  // One row per company, updated rather than duplicated.
  await container.services.companyRecords.save(COMPANY, { ice: '001234567000089', city: 'Dakhla' }, reviewer)
  const again = await container.services.companyRecords.find(COMPANY)
  assert.equal(again.city, 'Dakhla')
  assert.equal(await container.repositories.companyRecords.countAll(), 1)
})

test('an ICE that is not fifteen digits is refused', async (t) => {
  const container = await createTestContainer()
  t.after(() => container.db.close?.())

  // A wrong ICE on a company profile is worse than no ICE: it is the number
  // somebody would put on an invoice.
  await assert.rejects(
    () => container.services.companyRecords.save(COMPANY, { ice: '12345' }, null),
    /fifteen digits/,
  )
  assert.equal(await container.services.companyRecords.find(COMPANY), null)

  // Spacing from a copy-paste is forgiven, because the digits are what matter.
  const saved = await container.services.companyRecords.save(COMPANY, { ice: '001234567 000089' }, null)
  assert.equal(saved.ice, '001234567000089')
})

test('the register lookup is disabled without a token, and never writes on its own', async (t) => {
  const container = await createTestContainer()
  t.after(() => container.db.close?.())

  assert.equal(await container.services.companyRecords.lookupConfigured(), false)
  const result = await container.services.companyRecords.lookup(COMPANY)
  assert.deepEqual(result, { configured: false, candidates: [], error: null })

  // Even a lookup that finds something records nothing by itself: matching
  // 5,000 Moroccan company names to a register by name alone is a guess, and
  // the award data carries no ICE to join on.
  assert.equal(await container.services.companyRecords.find(COMPANY), null)
})

test('the lookup asks OpenCorporates the way its API expects, and shapes the answer', async () => {
  const calls = []
  const lookup = createCompanyLookup({
    apiToken: 'test-token',
    fetchImpl: async (url) => {
      calls.push(new URL(url))
      return {
        ok: true,
        json: async () => ({
          results: {
            companies: [
              { company: {
                  name: 'STE EXEMPLE SARL', company_number: '123456', company_type: 'SARL',
                  current_status: 'Active', registered_address_in_full: '12 rue des Écoles, Laâyoune',
                  incorporation_date: '2015-03-02',
                  opencorporates_url: 'https://opencorporates.com/companies/ma/123456' } },
              { company: { name: null } },
            ],
          },
        }),
      }
    },
  })

  assert.equal(await lookup.isConfigured(), true)
  const { configured, candidates, error } = await lookup.search('STE EXEMPLE SARL')

  assert.equal(configured, true)
  assert.equal(error, null)
  assert.equal(candidates.length, 1, 'a nameless row is dropped rather than shown blank')
  assert.deepEqual(candidates[0], {
    name: 'STE EXEMPLE SARL',
    registryNumber: '123456',
    legalForm: 'SARL',
    status: 'Active',
    address: '12 rue des Écoles, Laâyoune',
    incorporatedOn: '2015-03-02',
    sourceUrl: 'https://opencorporates.com/companies/ma/123456',
  })

  const [url] = calls
  assert.equal(url.origin + url.pathname, 'https://api.opencorporates.com/v0.4/companies/search')
  assert.equal(url.searchParams.get('jurisdiction_code'), 'ma', 'Morocco, not everywhere')
  assert.equal(url.searchParams.get('q'), 'STE EXEMPLE SARL')
  assert.equal(url.searchParams.get('api_token'), 'test-token')
})

test('a refused or broken lookup explains itself instead of failing silently', async () => {
  const cases = [
    [401, /token was refused/],
    [403, /does not cover/],
    [429, /rate limit/],
    [500, /answered 500/],
  ]
  for (const [status, expected] of cases) {
    const lookup = createCompanyLookup({ apiToken: 't', fetchImpl: async () => ({ ok: false, status }) })
    const result = await lookup.search('X')
    assert.equal(result.configured, true)
    assert.deepEqual(result.candidates, [])
    assert.match(result.error, expected, `status ${status}`)
  }

  const broken = createCompanyLookup({
    apiToken: 't', fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND') },
  })
  assert.match((await broken.search('X')).error, /ENOTFOUND/)
})

test('a token entered in the panel works on the next lookup, not the next restart', async () => {
  let token = ''
  const lookup = createCompanyLookup({
    resolve: async () => ({ apiToken: token }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ results: { companies: [] } }) }),
  })

  assert.equal(await lookup.isConfigured(), false)
  assert.equal((await lookup.search('X')).configured, false)

  token = 'a-token'
  assert.equal(await lookup.isConfigured(), true)
  assert.equal((await lookup.search('X')).configured, true)
})

test('a record whose fields were all cleared reads as no record', async (t) => {
  const container = await createTestContainer()
  t.after(() => container.db.close?.())

  await container.services.companyRecords.save(COMPANY, { city: 'Agadir' }, null)
  assert.equal((await container.services.companyRecords.find(COMPANY)).city, 'Agadir')

  // An all-empty row still carries a "verified" timestamp, which would claim
  // somebody checked something that is not there.
  await container.services.companyRecords.save(COMPANY, {}, null)
  assert.equal(await container.services.companyRecords.find(COMPANY), null)
})
