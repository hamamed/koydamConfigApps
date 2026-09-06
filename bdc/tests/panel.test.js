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
