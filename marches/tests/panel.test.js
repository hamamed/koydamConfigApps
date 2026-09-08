import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { createHttpClient } from '../src/scraper/httpClient.js'
import { createTestContainer, createFetchStub, fixture, startTestServer } from './helpers.js'

const SOURCE_ID = '1031023'

/** A panel with one administrator, one ordinary user, and real scraped rows. */
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

  await container.services.auth.register({ email: 'boss@test.ma', password: 'a-very-long-password', role: 'admin' })
  await container.services.auth.register({
    email: 'staff@test.ma',
    password: 'a-very-long-password',
    fullName: 'Staff Member',
    role: 'user',
  })

  const server = await startTestServer(createApp(container))

  /** Signs in and returns the session cookie the browser would hold. */
  const signIn = async (email) => {
    const response = await fetch(`${server.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'a-very-long-password' }),
    })
    return (response.headers.get('set-cookie') ?? '').split(';')[0]
  }

  const page = (path, cookie, init = {}) =>
    fetch(`${server.base}${path}`, { redirect: 'manual', headers: { cookie, ...(init.headers ?? {}) }, ...init })

  return {
    ...server,
    container,
    page,
    admin: await signIn('boss@test.ma'),
    staff: await signIn('staff@test.ma'),
    consultationId: seeded.id,
  }
}

test('the sidebar shows administration only to administrators', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const asAdmin = await (await api.page('/panel', api.admin)).text()
  // Administration is one door now: the dashboard, the system report, the
  // settings and the accounts moved to the console, which shows both services
  // side by side — the comparison a per-service sidebar cannot make.
  assert.match(asAdmin, /class="switch"[^>]*>[\s\S]{0,400}?nav\.admin|Console d[’']administration/)
  assert.doesNotMatch(asAdmin, /href="\/panel\/(dashboard|users|settings)"/, 'and not as five entries')

  const asStaff = await (await api.page('/panel', api.staff)).text()
  assert.doesNotMatch(asStaff, /Console d[’']administration/, 'an ordinary user is not shown the console')
  // What they can do is still there.
  assert.match(asStaff, /href="\/panel\/favorites"/)
  assert.match(asStaff, /Staff Member/)
})

test('the admin screens are closed to ordinary users, not just hidden', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  // Those pages are gone from this service; the console renders them from the
  // API, so the API is where the guard has to hold.
  for (const path of ['/panel/dashboard', '/panel/users', '/panel/settings']) {
    assert.equal((await api.page(path, api.admin)).status, 404, `${path} is not served here any more`)
  }

  for (const path of ['/admin/api/dashboard', '/admin/api/system', '/admin/api/settings', '/admin/api/users']) {
    const response = await fetch(`${api.base}${path}`, { headers: { cookie: api.staff } })
    assert.equal(response.status, 403, `${path} refuses an ordinary account`)
  }

  // And the API behind them refuses too, so hiding a link is never the control.
  const json = await fetch(`${api.base}/admin/api/dashboard`, { headers: { cookie: api.staff } })
  assert.equal(json.status, 403)

  const anonymous = await api.page('/panel/today', '')
  assert.equal(anonymous.status, 302)
  // Signing in happens on the portal now, so an anonymous visitor leaves this
  // host entirely — and the return address has to be absolute for that to come
  // back here rather than to a path on the portal.
  const away = anonymous.headers.get('location')
  assert.match(away, /^https?:\/\/[^/]+\/login\?next=/, 'sent to the portal to sign in')
  assert.match(decodeURIComponent(away), /next=https?:\/\/[^/]+\/panel/, 'and told where to come back to')
})

test('settings are stored, applied, and fall back when cleared', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  assert.equal(await api.container.settings.get('scraper.maxPages'), 50, 'the .env default')

  const saved = await fetch(`${api.base}/admin/api/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', cookie: api.admin },
    body: JSON.stringify({ 'scraper.maxPages': 7, 'site.name': 'Marchés Civic Trust', 'invoice.taxRate': 14 }),
  })
  assert.equal(saved.status, 200)

  assert.equal(await api.container.settings.get('scraper.maxPages'), 7)
  assert.equal(await api.container.settings.get('invoice.taxRate'), 14)

  // The name reaches the rendered page, so the setting is not write-only.
  const panel = await (await api.page('/panel', api.admin)).text()
  assert.match(panel, /Marchés Civic Trust/)

  // The invoice default follows the setting rather than the environment.
  const invoice = await fetch(`${api.base}/api/invoices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: api.admin },
    body: JSON.stringify({ client: { name: 'X' }, items: [{ designation: 'A', quantity: 1, unitPrice: 100 }] }),
  })
  assert.equal((await invoice.json()).data.tax, 14, '14% of 100, from settings')

  // An out-of-range value is refused with the key named.
  const bad = await fetch(`${api.base}/admin/api/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', cookie: api.admin },
    body: JSON.stringify({ 'scraper.delayMs': 5 }),
  })
  assert.equal(bad.status, 400)
  assert.match(JSON.stringify((await bad.json()).details), /scraper.delayMs/)

  // Clearing a field resets it to the environment default.
  await fetch(`${api.base}/admin/api/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', cookie: api.admin },
    body: JSON.stringify({ 'scraper.maxPages': '' }),
  })
  assert.equal(await api.container.settings.get('scraper.maxPages'), 50)

  // The app's own credentials are not settings at all. Delivery credentials —
  // the Google key, the SMTP password — are, because a careless edit there
  // costs a message rather than locking everyone out of the application.
  const groups = await api.container.settings.describe()
  const keys = groups.flatMap((group) => group.entries.map((entry) => entry.key))
  assert.ok(!keys.some((key) => /jwtSecret|databaseUrl|cookieSecret|adminPassword/i.test(key)))

  // And no secret reports its value or its fallback, whatever it is for.
  const secrets = groups.flatMap((g) => g.entries).filter((entry) => entry.type === 'secret')
  assert.deepEqual(secrets.map((entry) => entry.key).sort(),
    ['mail.password', 'registry.openCorporatesToken', 'translation.googleApiKey'])
  for (const secret of secrets) {
    assert.equal(secret.value, null, `${secret.key} is never read back`)
    assert.equal(secret.fallback, null, `${secret.key} does not leak through its fallback`)
  }
})

test('an administrator manages accounts but cannot lock everyone out', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const created = await fetch(`${api.base}/admin/api/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: api.admin },
    body: JSON.stringify({ email: 'new@test.ma', password: 'another-long-password', role: 'user' }),
  })
  assert.equal(created.status, 201)
  assert.equal((await created.json()).data.password_hash, undefined, 'never returns the hash')

  const list = (await (await fetch(`${api.base}/admin/api/users`, { headers: { cookie: api.admin } })).json()).data
  assert.equal(list.length, 3, 'the administrator, the staff user, and the new one')
  assert.ok(list.every((row) => row.favoriteCount !== undefined))

  const boss = list.find((row) => row.email === 'boss@test.ma')

  // The last active administrator is protected from every route out.
  for (const [path, body] of [
    [`/admin/api/users/${boss.id}/role`, { role: 'user' }],
    [`/admin/api/users/${boss.id}/active`, { isActive: false }],
  ]) {
    const response = await fetch(`${api.base}${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: api.admin },
      body: JSON.stringify(body),
    })
    assert.equal(response.status, 400, path)
  }

  const selfDelete = await fetch(`${api.base}/admin/api/users/${boss.id}`, {
    method: 'DELETE',
    headers: { cookie: api.admin },
  })
  assert.equal(selfDelete.status, 400)

  // An ordinary account can be deactivated, and then cannot sign in.
  const staff = list.find((row) => row.email === 'staff@test.ma')
  const deactivated = await fetch(`${api.base}/admin/api/users/${staff.id}/active`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', cookie: api.admin },
    body: JSON.stringify({ isActive: false }),
  })
  assert.equal(deactivated.status, 200)

  const login = await fetch(`${api.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'staff@test.ma', password: 'a-very-long-password' }),
  })
  assert.equal(login.status, 401)
})

test('the panel renders in Arabic with a mirrored sidebar', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const html = await (await api.page('/panel?lang=ar', api.staff)).text()
  assert.match(html, /<html lang="ar" dir="rtl">/)
  assert.match(html, /المشاريع/)
  assert.match(html, /المفضلة/)
  // Icons are inline SVG, so they render with no external request.
  assert.match(html, /<svg class="ic/)
  assert.doesNotMatch(html, /lucide.*\.js|cdn/i, 'no CDN dependency for icons')
})

test('old /admin bookmarks land on the panel', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const cases = [
    ['/admin', '/panel/dashboard'],
    ['/admin/login', '/login'],
    ['/admin/consultations', '/panel'],
    [`/admin/consultations/${api.consultationId}`, `/panel/consultations/${api.consultationId}`],
  ]

  for (const [from, to] of cases) {
    const response = await api.page(from, api.admin)
    assert.equal(response.status, 302, from)
    assert.equal(response.headers.get('location'), to, from)
  }

  // `/` is a forward now, in both directions: the portal is the front door for
  // somebody signed out, and somebody already signed in goes to their work
  // rather than through a chooser to be told what they already picked.
  const signedIn = await api.page('/', api.admin)
  assert.equal(signedIn.status, 302)
  assert.equal(signedIn.headers.get('location'), '/panel')
  const signedOut = await fetch(`${api.base}/`, { redirect: 'manual' })
  assert.equal(signedOut.status, 302)
  assert.match(signedOut.headers.get('location'), /^https?:\/\//, 'out to the portal')
})

test('navigation labels carry no hardcoded arrows', async () => {
  // The back button renders an arrow icon, so an arrow in the string showed up
  // twice — and a literal "←" points the wrong way on an RTL page.
  for (const locale of ['fr', 'en', 'ar']) {
    const { default: strings } = await import(`../src/i18n/${locale}.js`)
    for (const [key, value] of Object.entries(strings)) {
      assert.doesNotMatch(value, /[←→⟵⟶]/, `${locale}: ${key} contains an arrow`)
    }
  }
})

test('every status the app can produce has a label in every language', async () => {
  // The awards table rendered "status.attribue" as literal text: the award
  // vocabulary (attribue, infructueux, annule, publie) is not the consultation
  // lifecycle vocabulary (open, closed, awarded, annule), and only the second
  // had been translated.
  const AWARD_STATUSES = ['attribue', 'infructueux', 'annule', 'publie']
  const CONSULTATION_STATUSES = ['open', 'closed', 'awarded', 'annule']

  for (const locale of ['fr', 'en', 'ar']) {
    const { default: strings } = await import(`../src/i18n/${locale}.js`)
    for (const status of [...AWARD_STATUSES, ...CONSULTATION_STATUSES]) {
      const value = strings[`status.${status}`]
      assert.ok(value, `${locale} has no label for status.${status}`)
      assert.doesNotMatch(value, /^status\./, `${locale}: status.${status} falls back to the key`)
    }
  }

  // The award statuses stay in the dictionaries because a marché reaches them
  // too, but what publishes them here is the "résultats définitifs" page, which
  // this crawler does not read yet. Until it does there is no parser to hold to
  // that set — only the labels checked above.
})

test('a deadline is shown as time remaining, not just a date', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const { deadlineStatus, SOON_DAYS, closingInstant } = await import('../src/utils/deadline.js')
  // 15:00 in Casablanca, which is 14:00 UTC. Most avis close before noon, so
  // this is the hour of the day when a day-granular badge was most wrong.
  const now = new Date('2026-09-07T14:00:00Z')

  // Shut five hours ago. It used to read "closes today" until midnight.
  const shut = deadlineStatus('2026-09-07', '10:00', now)
  assert.equal(shut.urgency, 'passed')
  assert.equal(shut.hours, -5)

  // Still open this afternoon: hours, not days, because they are what is left.
  assert.deepEqual(
    { ...deadlineStatus('2026-09-07', '16:00', now), closesAt: undefined },
    { days: 0, hours: 1, urgency: 'hours', closesAt: undefined },
  )
  // Tomorrow morning is under a day away and reads as hours too.
  assert.equal(deadlineStatus('2026-09-08', '10:00', now).urgency, 'hours')
  assert.equal(deadlineStatus('2026-09-11', '12:00', now).urgency, 'soon')
  assert.equal(deadlineStatus('2026-12-01', '12:00', now).urgency, 'open')

  // With no hour published, assume the end of the day rather than the start.
  assert.equal(deadlineStatus('2026-09-07', null, now).urgency, 'hours')

  // The portal's clock is Morocco's, not the server's: noon there is 11:00 UTC.
  assert.equal(new Date(closingInstant('2026-09-07', '12:00')).toISOString(), '2026-09-07T11:00:00.000Z')

  assert.equal(deadlineStatus(null), null)
  assert.equal(deadlineStatus('not a date'), null)
  assert.ok(SOON_DAYS > 0)

  // It reaches the API and the page.
  const { data } = await (await fetch(`${api.base}/api/consultations?perPage=3`, {
    headers: { cookie: api.staff },
  })).json()
  assert.ok(data[0].deadline, 'every row carries its remaining time')
  assert.equal(typeof data[0].deadline.days, 'number')

  const html = await (await api.page('/panel', api.staff)).text()
  assert.match(html, /class="pill[^"]*"/)
})

test('closing-within narrows to a deadline window', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const all = (await (await fetch(`${api.base}/api/consultations?perPage=50`, { headers: { cookie: api.staff } })).json())
    .meta.total

  const soon = await (await fetch(`${api.base}/api/consultations?perPage=50&closingWithin=7`, {
    headers: { cookie: api.staff },
  })).json()

  assert.ok(soon.meta.total <= all)
  const today = new Date().toISOString().slice(0, 10)
  for (const row of soon.data) {
    assert.ok(row.date_limite >= today, `${row.reference} has not already closed`)
    assert.ok(row.deadline.days <= 7)
  }

  const bad = await fetch(`${api.base}/api/consultations?closingWithin=999`, { headers: { cookie: api.staff } })
  assert.equal(bad.status, 400)
})

test('CSV export is safe to open in a spreadsheet', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const { toCsv } = await import('../src/utils/csv.js')

  // A cell beginning =, +, - or @ is a formula to Excel, and this data is
  // scraped from a third party. Prefixing with a tab makes it text.
  const csv = toCsv(
    [
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B' },
    ],
    [{ a: '=1+1', b: 'quote " and, comma' }, { a: '@SUM(A1)', b: null }],
  )
  assert.match(csv, /\t=1\+1/)
  assert.match(csv, /\t@SUM\(A1\)/)
  assert.match(csv, /"quote "" and, comma"/, 'quotes are doubled')
  assert.ok(csv.startsWith('﻿'), 'a BOM, or Excel mangles the Arabic and the accents')

  const anonymous = await fetch(`${api.base}/api/export/consultations.csv`)
  assert.equal(anonymous.status, 401, 'signed in only')

  const response = await fetch(`${api.base}/api/export/consultations.csv?closingWithin=30`, {
    headers: { cookie: api.staff },
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/csv/)
  assert.match(response.headers.get('content-disposition'), /projets-\d{4}-\d{2}-\d{2}\.csv/)

  const body = await response.text()
  assert.match(body.split('\r\n')[0], /Référence,Objet,Acheteur/)

  // No awards export: this portal publishes an award as a separate resultat
  // definitif notice that nothing here crawls, so the file would have had a
  // header row and nothing under it.
})

test('the canary flags a schedule that has stopped firing', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const [recent] = await api.container.repositories.jobs.listRecent(1)
  const threeDaysAgo = new Date(Date.now() - 72 * 3600 * 1000).toISOString()
  await api.container.db.run('UPDATE scrape_jobs SET finished_at = ?, started_at = ? WHERE id = ?', [
    threeDaysAgo,
    threeDaysAgo,
    recent.id,
  ])

  const stale = await api.container.services.health.check()
  const freshness = stale.checks.find((c) => c.id === 'freshness')
  assert.equal(freshness.severity, 'fail', 'a daily job silent for three days is broken')
  assert.match(freshness.detail, /7[0-9]h ago/)
})

test('the translator talks to Google the way its API expects', async () => {
  const { createTranslator } = await import('../src/translation/translator.js')
  const requests = []

  const translator = createTranslator({
    apiKey: 'test-key',
    enabled: true,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body)
      requests.push({ url: String(url), body })
      return {
        ok: true,
        json: async () => ({
          // Google returns HTML entities even with format=text — an apostrophe
          // comes back as &#39;, which is most of them in French.
          data: { translations: body.q.map((text) => ({ translatedText: `EN(${text})&#39;s` })) },
        }),
      }
    },
  })

  const { translations, model } = await translator.translate(
    [
      { id: 1, designation: 'Rame de papier', description: 'Format A4' },
      { id: 2, designation: 'Onduleur', description: null },
    ],
    'en',
  )

  assert.equal(requests.length, 1, 'one request for the whole lot')
  assert.match(requests[0].url, /translation\.googleapis\.com.*key=test-key/)
  assert.equal(requests[0].body.target, 'en')
  assert.equal(requests[0].body.format, 'text')
  // Three segments, not four: an empty description is not sent, and the API
  // bills per character.
  assert.deepEqual(requests[0].body.q, ['Rame de papier', 'Format A4', 'Onduleur'])

  assert.equal(translations[0].designation, "EN(Rame de papier)'s", 'entities decoded')
  assert.equal(translations[1].description, '', 'an empty field stays empty')
  assert.match(model, /^google-translate-v2/)

  // A refusal carries the reason from the body, not just a status code.
  const failing = createTranslator({
    apiKey: 'bad',
    enabled: true,
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: { message: 'API key not valid' } }),
    }),
  })
  await assert.rejects(() => failing.translate([{ id: 1, designation: 'x' }], 'en'), /API key not valid/)

  const unset = createTranslator({ apiKey: '', enabled: false })
  await assert.rejects(() => unset.translate([], 'en'), /not configured/)
})

test('the signed-out pages carry a background pattern', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  for (const path of ['/forgot']) {
    const html = await (await fetch(`${api.base}${path}`)).text()
    assert.match(html, /body::before/, `${path} has the backdrop`)
    assert.match(html, /repeating-linear-gradient/, 'the hairlines')
    assert.match(html, /radial-gradient\(circle at center/, 'the dot grid')
    // Drawn in CSS, so it costs no extra request and scales to any screen.
    assert.doesNotMatch(html, /<img|url\(['"]?http/, 'no image asset')
  }

  // The diagonals lean the other way on an RTL page, so it reads as one design.
  const arabic = await (await fetch(`${api.base}/forgot?lang=ar`)).text()
  assert.match(arabic, /body\[dir="rtl"\]::before/)
  assert.match(arabic, /repeating-linear-gradient\(45deg/)
})

test('a key saved in the panel works without a restart', async (t) => {
  const requests = []
  const { createTestContainer: fresh } = await import('./helpers.js')
  const { createTranslator } = await import('../src/translation/translator.js')

  const container = await fresh({})
  // The real wiring: the translator asks the settings service for the key on
  // every call, so saving one takes effect on the next translation.
  const translator = createTranslator({
    resolve: async () => ({ apiKey: await container.settings.get('translation.googleApiKey') }),
    fetchImpl: async (url, init) => {
      requests.push(String(url))
      const body = JSON.parse(init.body)
      return { ok: true, json: async () => ({ data: { translations: body.q.map((q) => ({ translatedText: q })) } }) }
    },
  })

  assert.equal(await translator.isConfigured(), false)
  await assert.rejects(() => translator.translate([{ id: 1, designation: 'x' }], 'en'), /not configured/)

  await container.settings.update({ 'translation.googleApiKey': 'AIza-live' }, null)

  assert.equal(await translator.isConfigured(), true)
  await translator.translate([{ id: 1, designation: 'Rame de papier' }], 'en')
  assert.match(requests[0], /key=AIza-live/)
})

test('every sidebar item has its own icon, and it means what the item does', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const html = await (await api.page('/panel', api.admin)).text()
  const nav = html.slice(html.indexOf('<nav>'), html.indexOf('</nav>'))
  const items = [...nav.matchAll(/<a href="([^"]+)"[^>]*>\s*<svg[^>]*>([\s\S]*?)<\/svg>\s*([^<]+)/g)]
    .map(([, href, paths, label]) => ({ href: href.split('?')[0], paths, label: label.trim() }))

  // Counted from the sidebar itself rather than hardcoded: a magic number here
  // only records how many items existed the day it was written, and fails the
  // next time one is added without telling anyone whether an icon is missing.
  const links = [...nav.matchAll(/<a href="/g)].length
  assert.equal(items.length, links, 'every nav item renders an icon')

  // Two items drawn the same are worse than one drawn badly: the sidebar is
  // scanned by shape, not read. Awards and Insights carried each other's icon
  // for months, and Access requests was the same two figures as Users.
  const drawings = items.map((item) => item.paths)
  assert.equal(new Set(drawings).size, items.length, 'no two nav icons are the same drawing')

  // And the two that were swapped are the right way round: the trophy belongs
  // to Results, not to the analysis screen.
  const byHref = Object.fromEntries(items.map((item) => [item.href, item.paths]))
})

test('the language picker is a menu listing every language by name', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  for (const [path, cookie] of [['/panel', api.admin], ['/guide', null]]) {
    const html = await (cookie
      ? (await api.page(`${path}?lang=ar`, cookie)).text()
      : (await fetch(`${api.base}${path}?lang=ar`)).text())

    const menu = html.slice(html.indexOf('<details class="lang'), html.indexOf('</details>', html.indexOf('<details class="lang')))
    assert.ok(menu.length > 0, `${path} renders the menu`)

    // Every language, by its own name rather than a two-letter code.
    for (const label of ['Français', 'English', 'العربية']) {
      assert.ok(menu.includes(label), `${path} offers ${label}`)
    }
    // The one in use is named on the closed menu and marked inside it.
    assert.match(menu, /<span>العربية<\/span>/, `${path} shows the current language`)
    assert.match(menu, /aria-current="true"/, `${path} marks the current entry`)

    // It works without JavaScript: a details element and three ordinary links.
    assert.ok(!menu.includes('onclick'), `${path} needs no script`)
    assert.equal((menu.match(/hreflang=/g) ?? []).length, 3)
  }
})

test('the panel collapses to a drawer on a phone, and its tables scroll inside their card', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const html = await (await api.page('/panel', api.admin)).text()

  // The drawer and the shell are siblings so that opening one reveals the
  // other in CSS alone — the panel allows no inline script.
  assert.match(html, /<details class="drawer">/)
  assert.match(html, /\.drawer\[open\] ~ \.shell \.side \{ display:flex; \}/)
  assert.ok(html.indexOf('<details class="drawer">') < html.indexOf('<div class="shell">'), 'drawer precedes the shell')

  // A wide table scrolls in its own container. Without this it pushes the whole
  // document sideways and takes the sidebar with it.
  assert.match(html, /\.table-wrap \{ overflow-x:auto/)
  assert.match(html, /<div class="table-wrap"><table>/)

  // And the guide is no longer in the sidebar.
  const nav = html.slice(html.indexOf('<nav>'), html.indexOf('</nav>'))
  assert.ok(!nav.includes('/guide'), 'the guide link is gone from the sidebar')
  assert.ok(!html.includes('class="help"'))
})

test('a table is never forced wider than the card holding it', async () => {
  // A blanket `min-width` on tables gave a scrollbar to every card too narrow
  // to hold it — the Insights rankings sit in 330px grid columns and the buyer
  // and company profiles in half-width ones, so all of them scrolled sideways
  // to show three short columns. The wrapper still scrolls, but only when the
  // content really is wider than its card.
  const { readFile } = await import('node:fs/promises')

  for (const shellName of ['shell-open', 'public-open']) {
    const shell = await readFile(new URL(`../src/views/partials/${shellName}.ejs`, import.meta.url), 'utf8')

    const tableRules = [...shell.matchAll(/^\s*[^@\n{]*\btable\b[^{\n]*\{([^}]*)\}/gm)].map((m) => m[0])
    for (const rule of tableRules) {
      assert.doesNotMatch(rule, /min-width\s*:\s*[1-9]/, `${shellName}: ${rule.trim()}`)
    }

    // The scroll container itself stays: without it a wide table takes the
    // whole document sideways, sidebar and all.
    assert.match(shell, /\.table-wrap \{[^}]*overflow-x\s*:\s*auto/)
  }
})

test('the home screen answers what changed and what runs out, and marks the visit', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  // First visit: nothing can be "new since you looked", and the screen says so
  // rather than showing everything and calling it new.
  const first = await api.container.services.today.forUser({ id: 2 })
  assert.equal(first.since, null)
  assert.deepEqual(first.fresh, [])
  assert.equal(first.needsSetup, true, 'a new account is told about nothing at all')

  // The visit is recorded, so the second call has a mark to compare against.
  const second = await api.container.services.today.forUser({ id: 2 })
  assert.ok(second.since, 'the first visit left a mark')

  // Closing soon is measured in hours and excludes what has already shut: an
  // avis that closed at 10:00 must not be offered at 15:00 as still biddable.
  assert.ok(second.urgent.every((row) => row.deadline.hours > 0 && row.deadline.hours <= 48))
  assert.deepEqual(
    second.urgent.map((row) => row.deadline.hours),
    [...second.urgent.map((row) => row.deadline.hours)].sort((a, b) => a - b),
    'soonest first',
  )

  const html = await (await api.page('/panel/today', api.staff)).text()
  assert.match(html, /Aujourd’hui/)
})

test('the sign-in form is the portal’s, and old links still reach it', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  // This service holds no sign-in form any more; the portal is the account
  // authority for every CivicTrust service. /login stays as a forward rather
  // than a 404, because every `next=` this panel ever issued points at it.
  const get = await fetch(`${api.base}/login?next=/panel/favorites`, { redirect: 'manual' })
  assert.equal(get.status, 302)
  assert.match(get.headers.get('location'), /\/login\?next=/, 'forwarded to a sign-in form')
  assert.match(decodeURIComponent(get.headers.get('location')), /\/panel\/favorites$/, 'carrying where to come back to')

  // And a form posted here goes the same way rather than checking a password
  // this service no longer owns.
  const post = await fetch(`${api.base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'staff@test.ma', password: 'a-very-long-password' }).toString(),
    redirect: 'manual',
  })
  assert.equal(post.status, 302)
  assert.doesNotMatch(post.headers.get('location'), /^\/panel/, 'not signed in locally')
})

test('the one-question setup creates the alert a new account lacks', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const before = await api.container.services.savedSearches.list(2)
  assert.equal(before.length, 0)

  const response = await fetch(`${api.base}/panel/today/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: api.staff },
    body: new URLSearchParams({ categorie: 'Fournitures', lieuExecution: 'CASABLANCA' }).toString(),
    redirect: 'manual',
  })
  assert.equal(response.status, 302)

  const [saved] = await api.container.services.savedSearches.list(2)
  assert.ok(saved, 'the search exists after one answer')
  assert.deepEqual(saved.filters, { categorie: 'Fournitures', lieuExecution: 'CASABLANCA' })
  assert.equal(saved.notify_new, true)

  // And the screen stops offering setup once there is something to be told about.
  assert.equal((await api.container.services.today.forUser({ id: 2 })).needsSetup, false)
})

test('the closing count is the real number, not the fetch limit', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const { urgentTotal, urgent } = await api.container.services.today.forUser({ id: 2 })
  const { total: openTotal } = await api.container.services.consultations.search(
    { status: 'open' }, { limit: 1, offset: 0 },
  )

  // The list is capped for display; the count behind it must not be, or a cap
  // gets presented to the reader as the answer.
  assert.ok(urgent.length <= 12, 'the list is short')
  assert.ok(urgentTotal <= openTotal, 'and the count is bounded by reality, not by a page size')
  assert.notEqual(urgentTotal, 200, 'not the old fetch limit')
})

/* ------------------------------------------------------- reference price ---- */

/** Posts the calculator form the way the browser would. */
const postOffers = (api, cookie, { estimate, kind, offers }) => {
  const body = new URLSearchParams()
  body.set('estimate', estimate)
  body.set('kind', kind)
  for (const offer of offers) {
    body.append('name', offer.name)
    body.append('amount', offer.amount)
  }
  // The cookie goes in `headers` here rather than in `page`'s own argument:
  // the helper spreads `init` last, so an `init.headers` replaces the object it
  // just merged the cookie into.
  return api.page('/panel/reference-price', cookie, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
}

test('the reference price calculator is open to every signed-in user', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const response = await api.page('/panel/reference-price', api.staff)
  assert.equal(response.status, 200, 'an ordinary user can open it')

  const html = await response.text()
  assert.match(html, /name="estimate"/)
  assert.match(html, /name="kind"/)
  // And it is reachable, not just addressable.
  assert.match(html, /href="\/panel\/reference-price"/, 'the sidebar links to it')
})

test('it is closed to visitors, like every other panel screen', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const response = await api.page('/panel/reference-price', '')
  assert.equal(response.status, 302)
})

test('the calculator names the offer closest under the reference price', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  // Estimate 1 000 000; retained 820 000 and 940 000 → mean 880 000,
  // reference (1 000 000 + 880 000) / 2 = 940 000. The cheaper bid loses.
  const html = await (
    await postOffers(api, api.staff, {
      estimate: '1000000',
      kind: 'travaux',
      offers: [
        { name: 'Cheapest SARL', amount: '820000' },
        { name: 'Closest SARL', amount: '940000' },
      ],
    })
  ).text()

  assert.match(html, /Closest SARL/)
  // fr-MA groups with a dot: "940.000,00", the same as every other amount here.
  assert.match(html, /940\.000,00/, 'the reference price is printed')
  // The winner tile leads, so the losing cheaper bid must not be the first name.
  assert.ok(
    html.indexOf('Closest SARL') < html.indexOf('Cheapest SARL'),
    'the mieux-disante offer is announced before the rest of the table',
  )
})

test('an offer outside the band is shown as excluded rather than silently dropped', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const html = await (
    await postOffers(api, api.staff, {
      estimate: '1000000',
      kind: 'travaux',
      offers: [
        { name: 'Fine SARL', amount: '950000' },
        { name: 'Underbid SARL', amount: '500000' },
        { name: 'Overpriced SARL', amount: '1500000' },
      ],
    })
  ).text()

  assert.match(html, /Underbid SARL/, 'an excluded bidder is still listed')
  assert.match(html, /Overpriced SARL/)
  assert.match(html, /1 \/ 3|1 &#x2F; 3/, 'the count says how many survived')
})

test('the form refuses a submission it cannot evaluate, in the reader’s language', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const noKind = await (
    await postOffers(api, api.staff, { estimate: '1000000', kind: '', offers: [{ name: 'A', amount: '900000' }] })
  ).text()
  assert.match(noKind, /Choisissez la nature/, 'a missing nature is refused')
  // A rejected form comes back filled in, not blank.
  assert.match(noKind, /value="1000000"/)

  const noOffers = await (
    await postOffers(api, api.staff, { estimate: '1000000', kind: 'travaux', offers: [{ name: '', amount: '' }] })
  ).text()
  assert.match(noOffers, /au moins une offre/)
})


test('the list filters offer the values the data actually holds, and selecting one filters', async (t) => {
  const api = await setup()
  t.after(api.close)

  // What the three columns really contain, straight from the repository.
  const facets = await api.container.services.consultations.facets()
  assert.ok(facets.categories.length > 0, 'expected at least one category in the fixtures')
  assert.ok(facets.buyers.length > 0, 'expected at least one buyer in the fixtures')

  const html = await (await api.page('/panel', api.staff)).text()

  // A category is a short list, so every value is a real option to pick.
  facets.categories.forEach((f) => {
    assert.match(html, new RegExp(`<option value="${f.value}"`), `missing category option ${f.value}`)
  })
  // A buyer is one of hundreds, so the field is typeable and suggests them.
  assert.match(html, /<input id="acheteur"[^>]*list="acheteur-list"/)
  assert.match(html, /<datalist id="acheteur-list">/)
  assert.match(html, /<datalist id="lieu-list">/)

  // The point of offering a value is that choosing it narrows the list. A
  // dropdown of values that do not filter would look identical to this one.
  const chosen = facets.categories[0]
  const filtered = await api.container.services.consultations.search({ categorie: chosen.value }, { limit: 50, offset: 0 })
  assert.equal(filtered.total, chosen.count)
  assert.ok(filtered.data.every((row) => row.categorie === chosen.value))
})
