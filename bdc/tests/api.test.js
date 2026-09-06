import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { createHttpClient } from '../src/scraper/httpClient.js'
import { createTestContainer, createFetchStub, fixture, startTestServer } from './helpers.js'

const REFERENCE = encodeURIComponent('AOO12/2026')

/** Boots the API over an in-memory database pre-filled from the HTML fixtures. */
async function setup() {
  const http = createHttpClient({
    fetchImpl: createFetchStub([
      [/consultation\/detail\/884512/, fixture('consultation-detail.html')],
      [/consultation\/detail\/884513/, fixture('consultation-detail-2.html')],
      [/resultat\/detail\//, fixture('result-detail.html')],
      [/consultation\/resultat/, fixture('results-page1.html')],
      [/page=2/, fixture('consultations-page2.html')],
      [/consultation\//, fixture('consultations-page1.html')],
    ]),
    delayMs: 0,
  })

  const container = await createTestContainer({ http })
  await container.runner.run({ source: 'all', maxPages: 5, fetchDetails: true })
  await container.services.auth.register({
    email: 'admin@test.ma',
    password: 'a-very-long-test-password',
    role: 'admin',
  })

  const server = await startTestServer(createApp(container))
  const login = await server.request('POST', '/api/auth/login', {
    body: { email: 'admin@test.ma', password: 'a-very-long-test-password' },
  })
  return { ...server, container, token: login.body.data.token }
}

test('applies the portal filter parameters', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const all = await api.request('GET', '/api/consultations')
  assert.equal(all.body.meta.total, 2)

  const byBuyer = await api.request(
    'GET',
    '/api/consultations?search_consultation_resultats[acheteur]=Conservation',
  )
  assert.equal(byBuyer.body.data.length, 1)
  assert.equal(byBuyer.body.data[0].reference, 'AOO12/2026')

  // Flat aliases are equivalent to the nested portal form names.
  const flat = await api.request('GET', '/api/consultations?categorie=Travaux&lieuExecution=Casablanca')
  assert.equal(flat.body.data.length, 1)
  assert.equal(flat.body.data[0].reference, 'BC45/2026')

  const byNature = await api.request(
    'GET',
    '/api/consultations?search_consultation_resultats[naturePrestation]=Achat',
  )
  assert.equal(byNature.body.data.length, 1)

  const byDateRange = await api.request(
    'GET',
    '/api/consultations?datePublicationStart=2026-05-13&datePublicationEnd=2026-05-31',
  )
  assert.equal(byDateRange.body.data.length, 1)
  assert.equal(byDateRange.body.data[0].reference, 'BC45/2026')

  const byReference = await api.request('GET', '/api/consultations?search_consultation_resultats[reference]=AOO 12/2026')
  assert.equal(byReference.body.data.length, 1)

  const noMatch = await api.request('GET', '/api/consultations?acheteur=Inexistant')
  assert.equal(noMatch.body.meta.total, 0)
})

test('rejects malformed filter values with a 400', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const badDate = await api.request('GET', '/api/consultations?datePublicationStart=12/05/2026')
  assert.equal(badDate.status, 400)
  assert.match(badDate.body.details[0], /ISO date/)

  const inverted = await api.request(
    'GET',
    '/api/consultations?datePublicationStart=2026-06-01&datePublicationEnd=2026-01-01',
  )
  assert.equal(inverted.status, 400)
})

test('returns a consultation with its articles and matched award', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const { status, body } = await api.request('GET', `/api/consultations/${REFERENCE}`)
  assert.equal(status, 200)
  assert.equal(body.data.reference, 'AOO12/2026')
  assert.equal(body.data.articles.length, 3)
  assert.equal(body.data.articles[0].unit_price, 9500)
  assert.equal(body.data.result.attributaire, 'SOCIETE TECHNO SARL')
  assert.equal(body.data.result.montant_attribue, 1_180_400)
  assert.equal(body.data.result.lots.length, 3)

  // Internal columns never leave the API.
  assert.equal(body.data.search_text, undefined)
  assert.equal(body.data.raw_json, undefined)

  const missing = await api.request('GET', '/api/consultations/DOES-NOT-EXIST')
  assert.equal(missing.status, 404)
})

test('favorites require authentication and carry the award through', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const anonymous = await api.request('GET', '/api/favorites')
  assert.equal(anonymous.status, 401)

  const added = await api.request('POST', '/api/favorites', {
    token: api.token,
    body: { reference: 'AOO 12/2026', note: 'À préparer', tags: ['informatique'] },
  })
  assert.equal(added.status, 201)
  assert.equal(added.body.data.consultation_reference, 'AOO12/2026')

  const list = await api.request('GET', '/api/favorites', { token: api.token })
  assert.equal(list.body.meta.total, 1)
  assert.equal(list.body.data[0].objet, 'Acquisition de matériel informatique pour les services centraux')
  assert.equal(list.body.data[0].favorite.note, 'À préparer')
  assert.deepEqual(list.body.data[0].favorite.tags, ['informatique'])
  assert.equal(list.body.data[0].result.attributaire, 'SOCIETE TECHNO SARL')
  assert.equal(list.body.data[0].isFavorite, true)

  // Adding twice updates the note instead of failing.
  await api.request('POST', '/api/favorites', { token: api.token, body: { reference: 'AOO12/2026', note: 'Revu' } })
  const afterRepeat = await api.request('GET', '/api/favorites', { token: api.token })
  assert.equal(afterRepeat.body.meta.total, 1)
  assert.equal(afterRepeat.body.data[0].favorite.note, 'Revu')

  // The main listing reports favourite state for signed-in callers.
  const listing = await api.request('GET', '/api/consultations', { token: api.token })
  assert.equal(listing.body.data.find((row) => row.reference === 'AOO12/2026').isFavorite, true)
  assert.equal(listing.body.data.find((row) => row.reference === 'BC45/2026').isFavorite, false)

  const unknown = await api.request('POST', '/api/favorites', { token: api.token, body: { reference: 'NOPE/1' } })
  assert.equal(unknown.status, 404)

  const removed = await api.request('DELETE', `/api/favorites/${REFERENCE}`, { token: api.token })
  assert.equal(removed.status, 200)
  assert.equal((await api.request('GET', '/api/favorites', { token: api.token })).body.meta.total, 0)
})

test('generates an invoice from selected articles and renders it as a PDF', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const articles = (await api.request('GET', `/api/consultations/${REFERENCE}/articles`)).body.data
  assert.equal(articles.length, 3)

  const created = await api.request('POST', '/api/invoices', {
    token: api.token,
    body: {
      consultationReference: 'AOO 12/2026',
      client: { name: 'SOCIETE TECHNO SARL', ice: '001234567000045', address: 'Rabat' },
      items: [
        { articleId: articles[0].id, quantity: 120, unitPrice: 9500 },
        { articleId: articles[1].id, quantity: 35 },
        { designation: 'Installation et mise en service', quantity: 1, unitPrice: 15_000 },
      ],
      taxRate: 20,
      notes: 'Livraison sous 60 jours.',
    },
  })

  assert.equal(created.status, 201)
  const invoice = created.body.data
  assert.match(invoice.invoice_number, /^FCT-\d{4}-0001$/)
  assert.equal(invoice.items.length, 3)

  // 120 x 9 500 + 35 x 4 250,50 + 15 000 = 1 303 767,50 HT
  assert.equal(invoice.subtotal, 1_303_767.5)
  assert.equal(invoice.tax, 260_753.5)
  assert.equal(invoice.total, 1_564_521)
  assert.equal(invoice.consultation_reference, 'AOO12/2026')
  assert.equal(invoice.items[1].unit_price, 4250.5, 'unit price falls back to the scraped article price')

  const pdf = await api.request('GET', `/api/invoices/${invoice.id}/pdf`, { token: api.token, raw: true })
  assert.equal(pdf.status, 200)
  assert.equal(pdf.headers.get('content-type'), 'application/pdf')
  assert.match(pdf.headers.get('content-disposition'), /FCT-\d{4}-0001\.pdf/)
  assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-')
  assert.ok(pdf.body.length > 1000)

  // Invoice numbers stay sequential.
  const second = await api.request('POST', '/api/invoices', {
    token: api.token,
    body: { client: { name: 'Autre client' }, items: [{ designation: 'Divers', quantity: 2, unitPrice: 100 }] },
  })
  assert.match(second.body.data.invoice_number, /-0002$/)
})

test('rejects invalid invoice payloads', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const cases = [
    [{ client: { name: 'X' }, items: [] }, /At least one invoice item/],
    [{ client: { name: '' }, items: [{ designation: 'A', quantity: 1, unitPrice: 1 }] }, /client.name is required/],
    [{ client: { name: 'X' }, items: [{ designation: 'A', quantity: 0, unitPrice: 1 }] }, /positive number/],
    [{ client: { name: 'X' }, items: [{ designation: 'A', quantity: 1, unitPrice: -5 }] }, /non-negative/],
    [{ client: { name: 'X' }, items: [{ articleId: 9999, quantity: 1, unitPrice: 1 }] }, /Unknown article ids/],
    [
      { client: { name: 'X' }, items: [{ designation: 'A', quantity: 1, unitPrice: 10 }], taxRate: 250 },
      /taxRate must be a percentage/,
    ],
  ]

  for (const [body, expected] of cases) {
    const response = await api.request('POST', '/api/invoices', { token: api.token, body })
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.match(response.body.error, expected)
  }

  // An article belonging to another consultation cannot be invoiced here.
  const foreign = (await api.request('GET', `/api/consultations/${encodeURIComponent('BC45/2026')}/articles`)).body.data
  const mismatch = await api.request('POST', '/api/invoices', {
    token: api.token,
    body: {
      consultationReference: 'AOO12/2026',
      client: { name: 'X' },
      items: [{ articleId: foreign[0].id, quantity: 1, unitPrice: 10 }],
    },
  })
  assert.equal(mismatch.status, 400)
  assert.match(mismatch.body.error, /do not belong to consultation/)
})

test('protects the admin API and exposes dashboard counters', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  assert.equal((await api.request('GET', '/admin/api/dashboard')).status, 401)

  const dashboard = await api.request('GET', '/admin/api/dashboard', { token: api.token })
  assert.equal(dashboard.status, 200)
  assert.equal(dashboard.body.data.counts.consultations, 2)
  assert.equal(dashboard.body.data.counts.results, 2)
  assert.equal(dashboard.body.data.counts.unmatchedResults, 1)
  assert.equal(dashboard.body.data.matchRate, 50)

  // A regular user must not reach the admin API.
  await api.container.services.auth.register({ email: 'user@test.ma', password: 'another-long-password' })
  const userLogin = await api.request('POST', '/api/auth/login', {
    body: { email: 'user@test.ma', password: 'another-long-password' },
  })
  const forbidden = await api.request('GET', '/admin/api/dashboard', { token: userLogin.body.data.token })
  assert.equal(forbidden.status, 403)

  const rematch = await api.request('POST', '/admin/api/rematch', { token: api.token })
  assert.equal(rematch.status, 200)
  assert.equal(rematch.body.data.unmatchedResults, 1)
})

test('does not leak whether an email exists on failed login', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const wrongPassword = await api.request('POST', '/api/auth/login', {
    body: { email: 'admin@test.ma', password: 'wrong-password-entirely' },
  })
  const unknownUser = await api.request('POST', '/api/auth/login', {
    body: { email: 'ghost@test.ma', password: 'wrong-password-entirely' },
  })

  assert.equal(wrongPassword.status, 401)
  assert.equal(unknownUser.status, 401)
  assert.equal(wrongPassword.body.error, unknownUser.body.error)
})

test('rate-limits repeated failed logins', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const attempt = () =>
    api.request('POST', '/api/auth/login', { body: { email: 'admin@test.ma', password: 'nope-nope-nope' } })

  const statuses = []
  for (let i = 0; i < 12; i += 1) statuses.push((await attempt()).status)

  assert.ok(statuses.includes(429), 'the limiter eventually rejects the burst')
  assert.equal(statuses[0], 401, 'the first attempts are evaluated normally')
})
