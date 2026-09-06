import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { createHttpClient } from '../src/scraper/httpClient.js'
import { createTestContainer, createFetchStub, fixture, startTestServer } from './helpers.js'

const SOURCE_ID = '375169'

/** A panel with one administrator, one ordinary user, and real scraped rows. */
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
  await container.runner.run({ source: 'all', maxPages: 1, fetchDetails: false })
  const consultation = await container.repositories.consultations.findBySourceId(SOURCE_ID)
  await container.runner.consultationScraper.scrapeDetail(consultation)

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
    consultationId: consultation.id,
  }
}

test('the sidebar shows administration only to administrators', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const asAdmin = await (await api.page('/panel', api.admin)).text()
  assert.match(asAdmin, /href="\/panel\/dashboard"/)
  assert.match(asAdmin, /href="\/panel\/users"/)
  assert.match(asAdmin, /href="\/panel\/settings"/)

  const asStaff = await (await api.page('/panel', api.staff)).text()
  assert.doesNotMatch(asStaff, /href="\/panel\/dashboard"/, 'a user is not shown the dashboard')
  assert.doesNotMatch(asStaff, /href="\/panel\/users"/)
  assert.doesNotMatch(asStaff, /href="\/panel\/settings"/)
  // What they can do is still there.
  assert.match(asStaff, /href="\/panel\/favorites"/)
  assert.match(asStaff, /Staff Member/)
})

test('the admin screens are closed to ordinary users, not just hidden', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  for (const path of ['/panel/dashboard', '/panel/users', '/panel/settings']) {
    const response = await api.page(path, api.staff)
    assert.equal(response.status, 302, path)
    assert.equal(response.headers.get('location'), '/panel', `${path} sends them where they can go`)
  }

  // And the API behind them refuses too, so hiding a link is never the control.
  const json = await fetch(`${api.base}/admin/api/dashboard`, { headers: { cookie: api.staff } })
  assert.equal(json.status, 403)

  const anonymous = await api.page('/panel/dashboard', '')
  assert.equal(anonymous.status, 302)
  assert.match(anonymous.headers.get('location'), /^\/login\?next=/)
})

test('a user tracks a project and keeps a private note on it', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const empty = await (await api.page('/panel/favorites', api.staff)).text()
  assert.match(empty, /Nothing tracked yet|Aucun projet suivi/)

  const added = await fetch(`${api.base}/api/favorites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: api.staff },
    body: JSON.stringify({ consultationId: api.consultationId, note: 'Deadline in October' }),
  })
  assert.equal(added.status, 201)

  const favorites = await (await api.page('/panel/favorites', api.staff)).text()
  assert.match(favorites, /Deadline in October/)
  assert.match(favorites, /pièces de rechanges/)

  // Favourites are per-account: the administrator's list is untouched.
  const adminFavorites = await (await api.page('/panel/favorites', api.admin)).text()
  assert.doesNotMatch(adminFavorites, /Deadline in October/)

  // The star reflects state on the projects list.
  const projects = await (await api.page('/panel', api.staff)).text()
  assert.match(projects, /aria-pressed="true"/)

  const removed = await fetch(`${api.base}/api/favorites/${api.consultationId}`, {
    method: 'DELETE',
    headers: { cookie: api.staff },
  })
  assert.equal(removed.status, 200)
  const staff = (await api.container.repositories.users.findByEmailWithSecret('staff@test.ma'))
  assert.equal(await api.container.services.favorites.count(staff.id), 0)
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

  // Secrets are not exposed as settings.
  const described = JSON.stringify(await api.container.settings.describe())
  assert.doesNotMatch(described, /jwt|secret|password|DATABASE_URL/i)
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
    ['/', '/panel'],
  ]

  for (const [from, to] of cases) {
    const response = await api.page(from, api.admin)
    assert.equal(response.status, 302, from)
    assert.equal(response.headers.get('location'), to, from)
  }
})

test('table cells stay table cells', async () => {
  // `display:inline-block` on the .ltr class, and `display:flex` on a <td>,
  // both take the cell out of the table layout: every value carrying it dropped
  // out of its column and bunched up under the previous header. The dashboard's
  // job table, the article table and the user table all rendered scrambled.
  const { readFile } = await import('node:fs/promises')
  const shell = await readFile(new URL('../src/views/partials/shell-open.ejs', import.meta.url), 'utf8')

  const ltrRule = shell.match(/^\s*\.ltr \{[^}]*\}/m)?.[0] ?? ''
  assert.ok(ltrRule, 'the .ltr rule still exists')
  assert.doesNotMatch(ltrRule, /display\s*:/, '.ltr must not change display — it is used on <td>')
  assert.match(ltrRule, /direction\s*:\s*ltr/)
  assert.match(ltrRule, /unicode-bidi\s*:\s*isolate/)

  for (const view of ['projects', 'favorites', 'consultation', 'dashboard', 'users', 'settings']) {
    const html = await readFile(new URL(`../src/views/panel/${view}.ejs`, import.meta.url), 'utf8')
    assert.doesNotMatch(html, /<t[dh][^>]*style="[^"]*display\s*:\s*(flex|grid|inline)/, `${view}.ejs`)
  }
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

test('the dashboard job table has one cell per column', async (t) => {
  const api = await setup()
  t.after(() => api.close())
  await api.container.repositories.jobs.start({ source: 'all', triggeredBy: 'test' })

  const html = await (await api.page('/panel/dashboard', api.admin)).text()
  const table = html.slice(html.indexOf('<thead>'), html.indexOf('</table>', html.indexOf('<thead>')))

  const headers = (table.match(/<th\b/g) ?? []).length
  const firstRow = table.slice(table.indexOf('<tbody>')).match(/<tr>([\s\S]*?)<\/tr>/)?.[1] ?? ''
  const cells = (firstRow.match(/<td\b/g) ?? []).length

  assert.equal(headers, 10)
  assert.equal(cells, headers, 'every column has a cell')
})

test('the awards tab lists results and links the matched ones', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const html = await (await api.page('/panel/awards', api.staff)).text()

  assert.match(html, /STE AMALIA DES ETOILES D/, 'the winner is shown')
  assert.match(html, /8064 MAD|8064/, 'the amount is shown')
  // The one award whose (reference, buyer) matched links back to its project.
  const linked = await api.container.repositories.results.findByReference('53/2026')
  assert.ok(linked[0].consultation_id)
  assert.match(html, new RegExp(`/panel/consultations/${linked[0].consultation_id}`))
  // The rest say so rather than pretending.
  assert.match(html, /Not linked|Non liée|غير مرتبط/)

  // It is a tab for everyone, not an admin screen.
  assert.match(html, /href="\/panel\/awards"/)
  assert.equal((await api.page('/panel/awards', api.staff)).status, 200)
})

test('an incremental crawl asks the portal for what is new, not for page one', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const seen = []
  const { createHttpClient } = await import('../src/scraper/httpClient.js')
  const { createTestContainer: fresh } = await import('./helpers.js')
  const container = await fresh({
    http: createHttpClient({
      fetchImpl: async (url) => {
        seen.push(String(url))
        return {
          ok: true,
          status: 200,
          url: String(url),
          headers: { getSetCookie: () => [] },
          text: async () => fixture('live-consultations-empty.html'),
        }
      },
      delayMs: 0,
    }),
  })

  await container.runner.run({ source: 'consultations', maxPages: 1, fetchDetails: false, sinceDays: 7 })

  const [requested] = seen
  const query = new URL(requested).searchParams
  const since = query.get('search_consultation_entreprise[dateMiseEnLigneStart]')

  assert.ok(since, 'the crawl carries a publication-date floor')
  assert.match(since, /^\d{4}-\d{2}-\d{2}$/, 'ISO — the portal ignores any other format')

  const expected = new Date()
  expected.setUTCDate(expected.getUTCDate() - 7)
  assert.equal(since, expected.toISOString().slice(0, 10))
  assert.ok(query.get('search_consultation_entreprise[pageSize]'), 'and always a page size')
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

  // And the parser cannot invent a status outside that set.
  const { normalizeResultStatus } = await import('../src/scraper/parsers/resultParser.js')
  for (const text of ['Attribué', 'Avis infructueux', 'Annulé', 'quelque chose', '']) {
    const status = normalizeResultStatus(text)
    assert.ok(status === null || AWARD_STATUSES.includes(status), `unexpected status ${status}`)
  }
})

test('the project list opens in the same order as the portal', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  // The portal orders both listings by deadline, furthest first — page 1 holds
  // next year's deadlines and the last page holds today's. Defaulting to
  // "newest published" meant our first row was never the portal's first row,
  // which is confusing with both open side by side.
  const listing = async (query = '') =>
    (await (await fetch(`${api.base}/api/consultations?perPage=10${query}`, { headers: { cookie: api.staff } })).json())
      .data

  const byDefault = await listing()
  assert.equal(byDefault[0].reference, '6/2026', 'the portal shows this one first too')
  assert.equal(byDefault[0].date_limite, '2027-03-16')

  /** Present values in order, then a check that empty ones came after them. */
  const ordered = (rows, field) => {
    const values = rows.map((row) => row[field])
    const present = values.filter((value) => value !== null)
    assert.deepEqual(values.slice(0, present.length), present, `${field}: empty values sort last`)
    return present
  }

  const furthest = ordered(byDefault, 'date_limite')
  assert.deepEqual(furthest, [...furthest].sort().reverse())

  const soonest = ordered(await listing('&sort=date_limite:asc'), 'date_limite')
  assert.deepEqual(soonest, [...soonest].sort(), 'closing soonest first')

  const published = ordered(await listing('&sort=date_publication:desc'), 'date_publication')
  assert.deepEqual(published, [...published].sort().reverse())

  // A column outside the allow-list falls back rather than reaching the SQL.
  const injected = await listing('&sort=password_hash:desc')
  assert.equal(injected[0].reference, '6/2026')
})

test('rows with no date sort last, not first', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  // SQLite treats NULL as the smallest value and PostgreSQL as the largest, so
  // a descending sort on a nullable column put the empty rows at the bottom on
  // one engine and at the very top on the other. The ORDER BY carries an
  // explicit IS NULL key so both agree.
  const { buildOrderBy } = await import('../src/db/sql.js')
  const clause = buildOrderBy('date_limite:desc', ['date_limite'], 'date_limite', { table: 'c' })
  assert.match(clause, /\(c\.date_limite IS NULL\)/)
  assert.match(clause, /c\.id DESC/, 'and a stable tiebreak, so paging cannot repeat a row')

  const consultation = await api.container.repositories.consultations.findBySourceId('375169')
  await api.container.repositories.consultations.update(consultation.id, { date_limite: null })

  const { data } = await (await fetch(`${api.base}/api/consultations?perPage=100`, {
    headers: { cookie: api.staff },
  })).json()
  assert.equal(data.at(-1).id, consultation.id, 'the row with no deadline is last')
})

test('a cancelled project shows why, and the notice explaining it', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const html = await (await api.page(`/panel/consultations/${api.consultationId}`, api.staff)).text()

  // The reason the buyer gave, and the notice they published with it.
  assert.match(html, /changement de la date limite/, 'the reason is shown')
  assert.match(html, /download\/annulation\/375169\/52333941/, 'the cancellation notice is linked')

  // The tender pack is listed too, by its own filename.
  assert.match(html, /avis 53 2026\.zip/)
  assert.match(html, /download\/375169\/52291457/)

  // The files stay on the portal — this links them, it does not serve copies.
  const links = [...html.matchAll(/href="(https:\/\/www\.marchespublics[^"]+)"/g)].map((m) => m[1])
  assert.ok(links.some((href) => href.includes('/download/')), 'links point at the portal')
})

test('cancelled projects can be filtered for', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const listing = async (query) =>
    (await (await fetch(`${api.base}/api/consultations?perPage=50${query}`, { headers: { cookie: api.staff } })).json())
      .data

  const cancelled = await listing('&status=annule')
  assert.ok(cancelled.length > 0, 'the fixtures contain withdrawn avis')
  assert.ok(cancelled.every((row) => row.status === 'annule' && row.is_cancelled === true))

  const open = await listing('&status=open')
  assert.ok(open.every((row) => row.status === 'open'))

  const all = await listing('&status=all')
  assert.ok(all.length > cancelled.length)

  // The filter is on an allow-list; an unknown state is refused, not ignored.
  const bad = await fetch(`${api.base}/api/consultations?status=nonsense`, { headers: { cookie: api.staff } })
  assert.equal(bad.status, 400)
})

test('the dashboard reports what the last crawl brought in, and when the next one is', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const { data } = await (await fetch(`${api.base}/admin/api/dashboard`, { headers: { cookie: api.admin } })).json()

  // The flat item counts on a job row are a combined total; the dashboard needs
  // projects and awards apart, which is what the per-run detail carries.
  assert.ok(data.lastRun, 'the setup crawl is reported')
  assert.equal(data.lastRun.status, 'success')
  assert.equal(data.lastRun.consultations.created, 10, 'new projects')
  assert.equal(data.lastRun.results.created, 10, 'new awards')
  assert.equal(typeof data.lastRun.durationMs, 'number')
  assert.equal(typeof data.lastRun.matchesLinked, 'number')

  // Next run is derived from the schedule setting, in UTC, always ahead of now.
  assert.match(data.schedule.runAt, /^\d{2}:\d{2}$/)
  assert.ok(new Date(data.schedule.nextRunAt) > new Date(), 'the next run is in the future')
  assert.equal(data.schedule.sinceDays, 7)

  const html = await (await api.page('/panel/dashboard', api.admin)).text()
  assert.match(html, /New projects|Nouveaux projets/)
  assert.match(html, /Next crawl|Prochaine collecte/)
  assert.match(html, /Cancelled projects|Projets annulés/)
})

test('a deadline is shown as time remaining, not just a date', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const { deadlineStatus, SOON_DAYS } = await import('../src/utils/deadline.js')
  const now = new Date('2026-09-06T10:00:00Z')
  assert.deepEqual(deadlineStatus('2026-09-06', now), { days: 0, urgency: 'today' })
  assert.deepEqual(deadlineStatus('2026-09-04', now), { days: -2, urgency: 'passed' })
  assert.equal(deadlineStatus(`2026-09-0${6 + SOON_DAYS}`, now).urgency, 'soon')
  assert.equal(deadlineStatus('2026-12-01', now).urgency, 'open')
  assert.equal(deadlineStatus(null), null)
  assert.equal(deadlineStatus('not a date'), null)

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

  const awards = await fetch(`${api.base}/api/export/awards.csv`, { headers: { cookie: api.staff } })
  assert.match((await awards.text()).split('\r\n')[0], /Attributaire/)
})

test('the canary notices the failures this crawler actually has', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const healthy = await api.container.services.health.check()
  assert.equal(healthy.severity, 'ok')
  assert.ok(healthy.checks.find((c) => c.id === 'freshness'))

  // Every real failure here has been silent: the job finishes and reports
  // success while the data quietly stops arriving. So a crawl that found
  // nothing, against a non-empty catalogue, is a failure whatever it claimed.
  const empty = await api.container.repositories.jobs.start({ source: 'all', triggeredBy: 'test' })
  await api.container.repositories.jobs.finish(empty.id, { status: 'success', stats: { itemsFound: 0 } })

  const starved = await api.container.services.health.check()
  assert.equal(starved.severity, 'fail')
  assert.match(starved.checks.find((c) => c.id === 'yield').detail, /found nothing at all/)

  // A field that stops parsing means the portal's labels moved again.
  await api.container.db.run('UPDATE consultations SET acheteur = NULL')
  const blind = await api.container.services.health.check()
  const buyer = blind.checks.find((c) => c.id === 'fieldAcheteur')
  assert.equal(buyer.severity, 'warn')
  assert.match(buyer.detail, /0% of/)

  // And it surfaces where someone will see it.
  const html = await (await api.page('/panel/dashboard', api.admin)).text()
  assert.match(html, /Crawler health|Santé du collecteur/)
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

test('award analysis answers what work like this goes for', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const overview = await api.container.services.analytics.overview({})

  assert.ok(overview.summary.awards > 0)
  assert.ok(overview.summary.median > 0, 'a median amount to price against')
  assert.ok(overview.summary.max >= overview.summary.median)
  assert.ok(overview.winners.length > 0 && overview.winners[0].label)
  assert.ok(overview.buyers.length > 0)

  // An unsuccessful avis has no price. Counting it would drag every median
  // toward zero and quietly understate what the work is worth.
  const unsuccessful = await api.container.repositories.results.findByReference('37/2026')
  assert.equal(unsuccessful[0].result_status, 'infructueux')
  assert.equal(unsuccessful[0].montant_attribue_cents, null)
  const winnerNames = overview.winners.map((w) => w.label)
  assert.ok(!winnerNames.includes(null) && !winnerNames.includes(''))

  // But it still counts toward the risk of bidding at all.
  assert.ok(overview.summary.unsuccessfulRate > 0, 'the unsuccessful rate sees it')

  // The median is the median, not the mean.
  const amounts = (await api.container.db.all(
    "SELECT montant_attribue_cents AS c FROM consultation_results WHERE result_status = 'attribue' AND montant_attribue_cents > 0 ORDER BY montant_attribue_cents",
  )).map((r) => Number(r.c))
  const mid = amounts.length % 2 ? amounts[(amounts.length - 1) / 2]
    : (amounts[amounts.length / 2 - 1] + amounts[amounts.length / 2]) / 2
  assert.equal(Math.round(overview.summary.median * 100), Math.round(mid))

  // And it narrows with the same filters the awards list uses.
  const narrowed = await api.container.services.analytics.overview({ acheteur: 'MAGHRAOUA' })
  assert.ok(narrowed.summary.awards < overview.summary.awards)

  const html = await (await api.page('/panel/insights', api.staff)).text()
  assert.match(html, /Award analysis|Analyse des attributions/)
  assert.match(html, /href="\/panel\/insights"/, 'and it is a tab for everyone')
})
