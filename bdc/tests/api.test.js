import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { createHttpClient } from '../src/scraper/httpClient.js'
import { createTestContainer, createFetchStub, fixture, startTestServer } from './helpers.js'

// The portal id of the consultation that has a matched award, a full article
// breakdown and a category. Its row id is resolved at setup time.
const SOURCE_ID = '375169'

/** Boots the API over an in-memory database pre-filled from the HTML fixtures. */
async function setup() {
  const http = createHttpClient({
    fetchImpl: createFetchStub([
      [/consultation\/show\//, fixture('live-consultation-detail.html')],
      [/consultation\/resultat/, fixture('live-results-matching.html')],
      [/page=2/, fixture('live-consultations-empty.html')],
      [/consultation\//, fixture('live-consultations.html')],
    ]),
    delayMs: 0,
  })

  const container = await createTestContainer({ http })
  await container.runner.run({ source: 'all', maxPages: 2, fetchDetails: false })
  // The stub serves one detail page, so only its consultation gets articles.
  const withArticles = await container.repositories.consultations.findBySourceId(SOURCE_ID)
  await container.runner.consultationScraper.scrapeDetail(withArticles)
  await container.services.auth.register({
    email: 'admin@test.ma',
    password: 'a-very-long-test-password',
    role: 'admin',
  })

  const server = await startTestServer(createApp(container))
  const login = await server.request('POST', '/api/auth/login', {
    body: { email: 'admin@test.ma', password: 'a-very-long-test-password' },
  })
  return { ...server, container, token: login.body.data.token, consultationId: withArticles.id }
}

test('applies the portal filter parameters', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const all = await api.request('GET', '/api/consultations')
  assert.equal(all.body.meta.total, 10)

  const byBuyer = await api.request(
    'GET',
    '/api/consultations?search_consultation_resultats[acheteur]=KHENIFRA',
  )
  assert.equal(byBuyer.body.data.length, 1)
  assert.equal(byBuyer.body.data[0].reference, '53/2026')

  // Flat aliases are equivalent to the nested portal form names.
  const flat = await api.request('GET', '/api/consultations?acheteur=IZEMMOUREN')
  assert.equal(flat.body.data.length, 1)
  assert.equal(flat.body.data[0].reference, '6/2026')

  const byCategory = await api.request(
    'GET',
    '/api/consultations?search_consultation_resultats[categorie]=Fournitures',
  )
  assert.equal(byCategory.body.data.length, 1, 'only the detail-scraped row has a category')

  const byLocation = await api.request(
    'GET',
    '/api/consultations?search_consultation_resultats[lieuExecution]=HOCEIMA',
  )
  assert.equal(byLocation.body.data.length, 1)

  const byReference = await api.request('GET', '/api/consultations?search_consultation_resultats[reference]=53/2026')
  assert.equal(byReference.body.data.length, 1)

  // A reference is a filter, not an address: it repeats across buyers.
  const lookup = await api.request('GET', '/api/consultations/by-reference/53%2F2026')
  assert.equal(lookup.status, 200)
  assert.ok(Array.isArray(lookup.body.data))

  const byDeadline = await api.request('GET', '/api/consultations?dateLimiteStart=2027-01-01')
  assert.equal(byDeadline.body.data.length, 1)
  assert.equal(byDeadline.body.data[0].reference, '6/2026')

  const freeText = await api.request('GET', '/api/consultations?q=pièces de rechange')
  assert.equal(freeText.body.data.length, 1, 'free text search is accent insensitive')

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

  const { status, body } = await api.request('GET', `/api/consultations/${api.consultationId}`)
  assert.equal(status, 200)
  assert.equal(body.data.reference, '53/2026')
  assert.equal(body.data.source_id, SOURCE_ID)
  assert.equal(body.data.acheteur, 'CENTRE HOSPITALIER PROVINCIAL DE KHENIFRA')
  assert.equal(body.data.categorie, 'Fournitures')
  assert.equal(body.data.articles.length, 19)
  assert.equal(body.data.articles[0].designation, 'CÂBLE PNI avec brassard')
  assert.equal(body.data.articles[0].quantity, 25)
  assert.equal(body.data.articles[0].unit, 'unité')
  assert.equal(body.data.result.attributaire, "STE AMALIA DES ETOILES D'OR")
  assert.equal(body.data.result.montant_attribue, 8064)

  // Internal columns never leave the API. `source_id` does — it is the portal's
  // own citable id — but the derived join keys do not.
  assert.equal(body.data.search_text, undefined)
  assert.equal(body.data.raw_json, undefined)
  assert.equal(body.data.content_hash, undefined)
  assert.equal(body.data.match_key, undefined)
  assert.equal(body.data.result.result_key, undefined)

  const missing = await api.request('GET', '/api/consultations/999999')
  assert.equal(missing.status, 404)
})

test('favorites require authentication and carry the award through', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const anonymous = await api.request('GET', '/api/favorites')
  assert.equal(anonymous.status, 401)

  const added = await api.request('POST', '/api/favorites', {
    token: api.token,
    body: { consultationId: api.consultationId, note: 'À préparer', tags: ['informatique'] },
  })
  assert.equal(added.status, 201)
  assert.equal(added.body.data.consultation_id, api.consultationId)

  const list = await api.request('GET', '/api/favorites', { token: api.token })
  assert.equal(list.body.meta.total, 1)
  assert.match(list.body.data[0].objet, /pièces de rechanges/)
  assert.equal(list.body.data[0].favorite.note, 'À préparer')
  assert.deepEqual(list.body.data[0].favorite.tags, ['informatique'])
  assert.equal(list.body.data[0].result.attributaire, "STE AMALIA DES ETOILES D'OR")
  assert.equal(list.body.data[0].isFavorite, true)

  // Adding twice updates the note instead of failing.
  await api.request('POST', '/api/favorites', {
    token: api.token,
    body: { consultationId: api.consultationId, note: 'Revu' },
  })
  const afterRepeat = await api.request('GET', '/api/favorites', { token: api.token })
  assert.equal(afterRepeat.body.meta.total, 1)
  assert.equal(afterRepeat.body.data[0].favorite.note, 'Revu')

  // The main listing reports favourite state for signed-in callers.
  const listing = await api.request('GET', '/api/consultations', { token: api.token })
  assert.equal(listing.body.data.find((row) => row.id === api.consultationId).isFavorite, true)
  assert.equal(listing.body.data.find((row) => row.reference === '6/2026').isFavorite, false)

  const unknown = await api.request('POST', '/api/favorites', { token: api.token, body: { consultationId: 999999 } })
  assert.equal(unknown.status, 404)

  const removed = await api.request('DELETE', `/api/favorites/${api.consultationId}`, { token: api.token })
  assert.equal(removed.status, 200)
  assert.equal((await api.request('GET', '/api/favorites', { token: api.token })).body.meta.total, 0)
})

test('generates an invoice from selected articles and renders it as a PDF', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const articles = (await api.request('GET', `/api/consultations/${api.consultationId}/articles`)).body.data
  assert.equal(articles.length, 19)
  assert.equal(articles[0].unit_price, null, 'the portal publishes no prices — the supplier quotes them')

  const created = await api.request('POST', '/api/invoices', {
    token: api.token,
    body: {
      consultationId: api.consultationId,
      client: { name: 'CENTRE HOSPITALIER PROVINCIAL DE KHENIFRA', ice: '001234567000045', address: 'Khénifra' },
      items: [
        // No quantity: it falls back to the 25 units the portal published.
        { articleId: articles[0].id, unitPrice: 450 },
        { articleId: articles[1].id, quantity: 10, unitPrice: 300 },
        { designation: 'Installation et mise en service', quantity: 1, unitPrice: 1500 },
      ],
      taxRate: 20,
      notes: 'Livraison sous 30 jours.',
    },
  })

  assert.equal(created.status, 201)
  const invoice = created.body.data
  assert.match(invoice.invoice_number, /^FCT-\d{4}-0001$/)
  assert.equal(invoice.items.length, 3)
  assert.equal(invoice.items[0].quantity, 25, 'quantity falls back to the scraped article')
  assert.equal(invoice.items[0].designation, 'CÂBLE PNI avec brassard')
  assert.equal(invoice.items[0].unit, 'unité')

  // 25 x 450 + 10 x 300 + 1 500 = 15 750 HT
  assert.equal(invoice.subtotal, 15_750)
  assert.equal(invoice.tax, 3_150)
  assert.equal(invoice.total, 18_900)
  assert.equal(invoice.consultation_id, api.consultationId)

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

  const articles = (await api.request('GET', `/api/consultations/${api.consultationId}/articles`)).body.data

  const cases = [
    [{ client: { name: 'X' }, items: [] }, /At least one invoice item/],
    [{ client: { name: '' }, items: [{ designation: 'A', quantity: 1, unitPrice: 1 }] }, /client.name is required/],
    [{ client: { name: 'X' }, items: [{ designation: 'A', quantity: 0, unitPrice: 1 }] }, /positive number/],
    [{ client: { name: 'X' }, items: [{ designation: 'A', quantity: 1, unitPrice: -5 }] }, /non-negative/],
    [{ client: { name: 'X' }, items: [{ articleId: 99_999, quantity: 1, unitPrice: 1 }] }, /Unknown article ids/],
    [
      { client: { name: 'X' }, items: [{ designation: 'A', quantity: 1, unitPrice: 10 }], taxRate: 250 },
      /taxRate must be a percentage/,
    ],
    // The portal never publishes a price, so an article alone cannot be billed:
    // the caller has to supply what the supplier quoted.
    [{ client: { name: 'X' }, items: [{ articleId: articles[0].id, quantity: 1 }] }, /non-negative amount/],
  ]

  for (const [body, expected] of cases) {
    const response = await api.request('POST', '/api/invoices', { token: api.token, body })
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.match(response.body.error, expected)
  }

  // An article belonging to another consultation cannot be invoiced here.
  const other = await api.container.repositories.consultations.findBySourceId('316430')
  await api.container.runner.consultationScraper.scrapeDetail(other)
  const foreign = (await api.request('GET', `/api/consultations/${other.id}/articles`)).body.data

  const mismatch = await api.request('POST', '/api/invoices', {
    token: api.token,
    body: {
      consultationId: api.consultationId,
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
  assert.equal(dashboard.body.data.counts.consultations, 10)
  assert.equal(dashboard.body.data.counts.results, 10)
  assert.equal(dashboard.body.data.counts.articles, 19)
  assert.equal(dashboard.body.data.counts.pendingDetails, 9, 'nine listings still have no detail page read')
  assert.equal(dashboard.body.data.counts.unmatchedResults, 9)
  assert.equal(dashboard.body.data.matchRate, 10)

  // A regular user must not reach the admin API.
  await api.container.services.auth.register({ email: 'user@test.ma', password: 'another-long-password' })
  const userLogin = await api.request('POST', '/api/auth/login', {
    body: { email: 'user@test.ma', password: 'another-long-password' },
  })
  const forbidden = await api.request('GET', '/admin/api/dashboard', { token: userLogin.body.data.token })
  assert.equal(forbidden.status, 403)

  const rematch = await api.request('POST', '/admin/api/rematch', { token: api.token })
  assert.equal(rematch.status, 200)
  assert.equal(rematch.body.data.unmatchedResults, 9)
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

test('serves the interface in French, English and Arabic', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const fr = await api.request('GET', '/api/i18n')
  assert.equal(fr.body.data.locale, 'fr', 'French is the default — the portal is French')
  assert.equal(fr.body.data.strings['nav.dashboard'], 'Tableau de bord')
  assert.deepEqual(
    fr.body.data.locales.map((l) => l.code),
    ['fr', 'en', 'ar'],
  )

  const en = await api.request('GET', '/api/i18n?lang=en')
  assert.equal(en.body.data.locale, 'en')
  assert.equal(en.body.data.strings['nav.dashboard'], 'Dashboard')

  const ar = await api.request('GET', '/api/i18n?lang=ar')
  assert.equal(ar.body.data.locale, 'ar')
  assert.equal(ar.body.data.strings['nav.dashboard'], 'لوحة القيادة')
  assert.equal(ar.body.data.locales.find((l) => l.code === 'ar').dir, 'rtl')

  // Every locale answers for every key, so no screen can render a blank label.
  const keys = Object.keys(fr.body.data.strings)
  for (const payload of [en.body.data.strings, ar.body.data.strings]) {
    const missing = keys.filter((key) => !payload[key])
    assert.deepEqual(missing, [], 'untranslated keys')
  }

  const unknown = await api.request('GET', '/api/i18n?lang=de')
  assert.equal(unknown.body.data.locale, 'fr', 'an unsupported language falls back')
})

test('renders the panel right-to-left in Arabic', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const french = await fetch(`${api.base}/login`)
  const frenchHtml = await french.text()
  assert.match(frenchHtml, /<html lang="fr" dir="ltr">/)
  assert.match(frenchHtml, /Adresse e-mail/)

  const arabic = await fetch(`${api.base}/login?lang=ar`)
  const arabicHtml = await arabic.text()
  assert.match(arabicHtml, /<html lang="ar" dir="rtl">/)
  assert.match(arabicHtml, /البريد الإلكتروني/)
  assert.equal(arabic.headers.get('content-language'), 'ar')
  // The choice is remembered, so it survives the redirect after signing in.
  assert.match(arabic.headers.get('set-cookie') ?? '', /lang=ar/)

  const english = await fetch(`${api.base}/login?lang=en`)
  assert.match(await english.text(), /Sign in/)
})

test('the panel shows every article of a consultation', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const login = await fetch(`${api.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@test.ma', password: 'a-very-long-test-password' }),
  })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]

  const page = await fetch(`${api.base}/panel/consultations/${api.consultationId}`, { headers: { cookie } })
  const html = await page.text()

  assert.equal(page.status, 200)
  assert.match(html, /CÂBLE PNI avec brassard/, 'the article breakdown is on the page')
  assert.match(html, /Caractéristiques et spécifications/)
  assert.match(html, /CENTRE HOSPITALIER PROVINCIAL DE KHENIFRA/)
  assert.match(html, /375169/, 'the portal id is shown, so a row can be traced back')
  // 19 articles plus the header row.
  assert.ok((html.match(/<tr>/g) ?? []).length >= 20)

  const arabic = await fetch(`${api.base}/panel/consultations/${api.consultationId}?lang=ar`, { headers: { cookie } })
  const arabicHtml = await arabic.text()
  assert.match(arabicHtml, /<html lang="ar" dir="rtl">/)
  assert.match(arabicHtml, /وحدة القياس/, 'article table headers are translated')
  assert.match(arabicHtml, /CÂBLE PNI avec brassard/, 'but scraped content is left as published')
})
