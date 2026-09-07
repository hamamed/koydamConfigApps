import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { createHttpClient } from '../src/scraper/httpClient.js'
import { createTestContainer, createFetchStub, fixture, startTestServer } from './helpers.js'

// The portal id of the consultation that has a matched award, a full article
// breakdown and a category. Its row id is resolved at setup time.
const SOURCE_ID = '1031023'

/** Boots the API over an in-memory database pre-filled from the HTML fixtures. */
async function setup() {
  const http = createHttpClient({
    fetchImpl: createFetchStub([
      [/EntrepriseDetailsConsultation/, fixture('live-ao-detail.html')],
      [/EntrepriseAdvancedSearch/, fixture('live-ao-listing.html')],
    ]),
    delayMs: 0,
  })

  const container = await createTestContainer({ http })
  // One page of the marchés listing, then the detail page of each row — which
  // is the only place the estimate is published.
  await container.runner.run({ source: 'marches', maxPages: 1, fetchDetails: true })
  // The fixture's first row, resolved by its portal id: the marché every test
  // that needs "one with an estimate" works against.
  const seeded = await container.repositories.consultations.findBySourceId(SOURCE_ID)

  await container.services.auth.register({
    email: 'admin@test.ma',
    password: 'a-very-long-test-password',
    role: 'admin',
  })

  const server = await startTestServer(createApp(container))
  const login = await server.request('POST', '/api/auth/login', {
    body: { email: 'admin@test.ma', password: 'a-very-long-test-password' },
  })
  return { ...server, container, token: login.body.data.token, consultationId: seeded.id }
}

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
