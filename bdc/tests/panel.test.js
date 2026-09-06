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

  // `/` used to bounce into the panel. It is the public landing page now, and
  // it stays a page for a signed-in visitor too — the privacy and terms pages
  // have to be reachable from inside the product, not only from outside it.
  const signedIn = await api.page('/', api.admin)
  assert.equal(signedIn.status, 200)
  const signedOut = await fetch(`${api.base}/`, { redirect: 'manual' })
  assert.equal(signedOut.status, 200)
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

test('the project list says which avis are cancelled, and why, without opening one', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const html = await (await api.page('/panel?status=annule&lang=fr&perPage=50', api.staff)).text()
  const cancelled = (await (await fetch(`${api.base}/api/consultations?status=annule&perPage=50`,
    { headers: { cookie: api.staff } })).json()).data
  assert.ok(cancelled.length >= 3, 'the fixtures contain withdrawn avis')

  // Every cancelled row says so on the row itself.
  assert.equal((html.match(/pill warn/g) ?? []).length, cancelled.length, 'one cancelled pill per row')
  assert.ok(html.includes('Annulée'))

  // Including the date and the reason the buyer published, for the rows that
  // carry them — that is the whole point of not having to open the avis.
  const withReason = cancelled.find((row) => row.motif_annulation)
  assert.ok(html.includes(withReason.motif_annulation), 'the reason is on the listing')
  assert.ok(html.includes(withReason.date_annulation), 'and the date it was withdrawn')

  // A row cancelled after its award was published is still cancelled. The award
  // pill used to win this cell, so the listing showed the winner's name and no
  // sign at all that the avis had been withdrawn.
  const alsoAwarded = cancelled.find((row) => row.result)
  assert.ok(alsoAwarded, 'the fixtures cancel an avis that was awarded')
  assert.ok(!html.includes(alsoAwarded.result.attributaire),
    'the winner does not stand in for the cancelled state')

  // Rows scraped from the listing alone have no date yet; the pill still renders.
  const noDate = cancelled.find((row) => !row.date_annulation)
  assert.ok(noDate, 'a listing-only cancellation carries no date')
  assert.ok(html.includes(`/panel/consultations/${noDate.id}?`), 'and is still listed')
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

test('every insights ranking opens the rows behind it', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const page = await (await api.page('/panel/insights', api.staff)).text()
  const overview = await api.container.services.analytics.overview({})

  /** The href as the page really builds it: URLSearchParams, then EJS escaping. */
  const href = (path, param, value) =>
    `${path}?${new URLSearchParams({ [param]: value }).toString()}`.replace(/&/g, '&amp;')

  // A ranking you cannot open is trivia. The useful move after "this company
  // wins a lot" is seeing exactly what they won.
  const winner = overview.winners[0].label
  assert.ok(page.includes(href('/panel/awards', 'attributaire', winner)), 'the winner opens their awards')

  // A buyer opens their whole record — what they publish, how often they
  // withdraw it, what it settles for — rather than one filtered list.
  const buyer = overview.buyers[0].label
  assert.ok(page.includes(`/panel/buyers/${encodeURIComponent(buyer)}?lang=fr`), 'the buyer opens their profile')
  assert.ok(page.includes(href('/panel', 'acheteur', buyer)), 'and what they have open')

  const category = overview.categories[0].label
  assert.ok(page.includes(href('/panel', 'categorie', category)), 'a category opens its projects')

  // And the links actually narrow, rather than landing on the whole list.
  const awards = await (await fetch(
    `${api.base}/api/results?attributaire=${encodeURIComponent(winner)}&perPage=50`,
    { headers: { cookie: api.staff } },
  )).json()

  assert.ok(awards.meta.total > 0)
  assert.ok(awards.meta.total < overview.summary.awards, 'a slice, not everything')
  assert.ok(
    awards.data.every((row) => row.attributaire.toLowerCase().includes(winner.toLowerCase())),
    'every row is theirs',
  )

  const projects = await (await fetch(`${api.base}/api/consultations?acheteur=${encodeURIComponent(buyer)}&perPage=50`, {
    headers: { cookie: api.staff },
  })).json()
  assert.ok(projects.data.every((row) => row.acheteur.toLowerCase().includes(buyer.toLowerCase())))
})

test('settings fields are laid out two to a row', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const html = await (await api.page('/panel/settings', api.admin)).text()
  assert.match(html, /class="cols-2"/)
  assert.doesNotMatch(html, /<div class="filters" style="align-items:start">/)
  // Two columns exactly, not "as many as fit" — a settings field is read one at
  // a time and the values here are long.
  assert.match(html, /\.cols-2 \{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/)
  assert.match(html, /@media \(max-width: 720px\) \{ \.cols-2 \{ grid-template-columns:1fr/, 'one column on a phone')
})

test('categories are counted where the data actually is', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  // The awards listing publishes no category — zero of ten thousand rows on the
  // live box carry one — so ranking awards by category showed an empty table.
  // Consultations do carry it, and it is the more useful question anyway.
  const awardsWithCategory = await api.container.db.get(
    "SELECT COUNT(*) AS total FROM consultation_results WHERE categorie IS NOT NULL AND categorie <> ''",
  )
  assert.equal(Number(awardsWithCategory.total), 0, 'the portal gives awards no category')

  const { categories } = await api.container.services.analytics.overview({})
  assert.ok(categories.length > 0, 'but the ranking is not empty')
  assert.ok(categories.every((row) => row.label && row.projects > 0))
  assert.ok(categories.every((row) => row.openProjects <= row.projects))

  const stored = await api.container.db.get(
    'SELECT COUNT(*) AS total FROM consultations WHERE categorie = ?',
    [categories[0].label],
  )
  assert.equal(categories[0].projects, Number(stored.total))
})

test('articles can be translated, and a translation is paid for once', async (t) => {
  const calls = []
  const { createTestContainer: fresh } = await import('./helpers.js')
  const { createHttpClient } = await import('../src/scraper/httpClient.js')

  // A stub in the translator's shape. The real one calls Claude; what matters
  // here is that the service asks once and then serves from the database.
  const translator = {
    isConfigured: () => true,
    model: 'claude-opus-5',
    translate: async (articles, target) => {
      calls.push({ count: articles.length, target })
      return {
        model: 'claude-opus-5',
        translations: articles.map((a) => ({
          id: a.id,
          designation: `[${target}] ${a.designation}`,
          description: a.description ? `[${target}] ${a.description}` : '',
        })),
      }
    },
  }

  const container = await fresh({
    translator,
    http: createHttpClient({
      fetchImpl: createFetchStub([
        [/consultation\/show\//, fixture('live-consultation-detail.html')],
        [/consultation\/resultat/, fixture('live-results-matching.html')],
        [/page=2/, fixture('live-consultations-empty.html')],
        [/consultation\//, fixture('live-consultations.html')],
      ]),
      delayMs: 0,
    }),
  })
  await container.runner.run({ source: 'consultations', maxPages: 1, fetchDetails: false })
  const consultation = await container.repositories.consultations.findBySourceId('375169')
  await container.runner.consultationScraper.scrapeDetail(consultation)

  const first = await container.services.translation.translateConsultation(consultation.id, 'en')
  assert.equal(first.translated, 19)
  assert.equal(first.cached, 0)
  assert.match(first.articles[0].designation, /^\[en\] CÂBLE PNI/)
  assert.equal(calls.length, 1)

  // Asking again costs nothing: the source text does not change.
  const second = await container.services.translation.translateConsultation(consultation.id, 'en')
  assert.equal(second.translated, 0)
  assert.equal(second.cached, 19)
  assert.equal(calls.length, 1, 'the model was not called a second time')
  assert.deepEqual(second.articles, first.articles)

  // A different language is a different translation.
  const arabic = await container.services.translation.translateConsultation(consultation.id, 'ar')
  assert.equal(arabic.translated, 19)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].target, 'ar')

  // Re-reading the detail page replaces the articles, and the translations go
  // with them through the foreign key — which is right: the source text moved.
  await container.runner.consultationScraper.scrapeDetail(consultation)
  assert.equal(await container.repositories.translations.countAll(), 0)

  await assert.rejects(
    () => container.services.translation.translateConsultation(consultation.id, 'de'),
    /Unsupported language/,
  )
})

test('the translate buttons are shown disabled, not hidden, when unconfigured', async (t) => {
  const { createTestContainer: fresh } = await import('./helpers.js')
  const { createHttpClient } = await import('../src/scraper/httpClient.js')
  const stub = (enabled) => ({ isConfigured: () => enabled, model: 'google-translate-v2', translate: async () => ({}) })

  const build = async (enabled) => {
    const container = await fresh({
      translator: stub(enabled),
      http: createHttpClient({
        fetchImpl: createFetchStub([
          [/consultation\/show\//, fixture('live-consultation-detail.html')],
          [/consultation\/resultat/, fixture('live-results-matching.html')],
          [/page=2/, fixture('live-consultations-empty.html')],
          [/consultation\//, fixture('live-consultations.html')],
        ]),
        delayMs: 0,
      }),
    })
    await container.runner.run({ source: 'consultations', maxPages: 1, fetchDetails: false })
    const row = await container.repositories.consultations.findBySourceId('375169')
    await container.runner.consultationScraper.scrapeDetail(row)
    await container.services.auth.register({ email: 'u@test.ma', password: 'a-very-long-password' })

    const server = await startTestServer(createApp(container))
    const login = await fetch(`${server.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'u@test.ma', password: 'a-very-long-password' }),
    })
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
    const html = await (await fetch(`${server.base}/panel/consultations/${row.id}`, { headers: { cookie } })).text()
    return { server, html, container, cookie, id: row.id }
  }

  const on = await build(true)
  t.after(() => on.server.close())
  const enabled = on.html.match(/<button[^>]*class="secondary translate-btn"[^>]*>/g) ?? []
  assert.equal(enabled.length, 3, 'one button per language')
  assert.ok(enabled.every((button) => !button.includes('disabled')))
  for (const language of ['Français', 'English', 'العربية']) assert.ok(on.html.includes(language))

  // An enabled button whose handler did not render is indistinguishable from a
  // broken one: it just does nothing. The script ships with the buttons.
  assert.match(on.html, new RegExp(`fetch\\('/api/consultations/${on.id}/translate'`))

  // Hiding the control entirely reads as a missing feature rather than one
  // waiting on a key, so it stays on the page and says why it cannot run.
  const off = await build(false)
  t.after(() => off.server.close())
  const shown = off.html.match(/<button[^>]*class="secondary translate-btn"[^>]*>/g) ?? []
  assert.equal(shown.length, 3, 'still shown')
  assert.ok(shown.every((button) => button.includes('disabled')), 'but not clickable')
  assert.match(off.html, /not configured|n’est pas configurée/)

  // And the endpoint refuses too, rather than relying on a disabled attribute.
  const refused = await fetch(`${off.server.base}/api/consultations/${off.id}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: off.cookie },
    body: JSON.stringify({ locale: 'en' }),
  })
  assert.equal(refused.status, 400)
  assert.match((await refused.json()).error, /not configured/)
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

  for (const path of ['/login', '/forgot']) {
    const html = await (await fetch(`${api.base}${path}`)).text()
    assert.match(html, /body::before/, `${path} has the backdrop`)
    assert.match(html, /repeating-linear-gradient/, 'the hairlines')
    assert.match(html, /radial-gradient\(circle at center/, 'the dot grid')
    // Drawn in CSS, so it costs no extra request and scales to any screen.
    assert.doesNotMatch(html, /<img|url\(['"]?http/, 'no image asset')
  }

  // The diagonals lean the other way on an RTL page, so it reads as one design.
  const arabic = await (await fetch(`${api.base}/login?lang=ar`)).text()
  assert.match(arabic, /body\[dir="rtl"\]::before/)
  assert.match(arabic, /repeating-linear-gradient\(45deg/)
})

test('the translate key is set from Settings, and never read back', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const describe = async () =>
    (await api.container.settings.describe())
      .flatMap((group) => group.entries)
      .find((entry) => entry.key === 'translation.googleApiKey')

  assert.equal((await describe()).isSet, false)

  const save = (body) =>
    fetch(`${api.base}/admin/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: api.admin },
      body: JSON.stringify(body),
    })

  assert.equal((await save({ 'translation.googleApiKey': 'AIza-secret-value' })).status, 200)

  // Stored and usable...
  assert.equal(await api.container.settings.get('translation.googleApiKey'), 'AIza-secret-value')
  assert.equal(await api.container.services.translation.isConfigured(), true)

  // ...but never handed back. A field that renders the key is a field that
  // leaks it to anyone who views source, and into every error report after.
  const entry = await describe()
  assert.equal(entry.isSet, true)
  assert.equal(entry.value, null)
  assert.doesNotMatch(JSON.stringify(await api.container.settings.describe()), /AIza-secret-value/)

  const page = await (await api.page('/panel/settings', api.admin)).text()
  assert.doesNotMatch(page, /AIza-secret-value/, 'not in the rendered page either')
  assert.match(page, /type="password"/)

  // An empty submission means "no change" — the field is empty on every load,
  // so treating it as "erase" would wipe the key on any save that did not
  // retype it.
  await save({ 'translation.googleApiKey': '', 'site.name': 'Untouched' })
  assert.equal(await api.container.settings.get('translation.googleApiKey'), 'AIza-secret-value')
  assert.equal(await api.container.settings.get('site.name'), 'Untouched')

  // Erasing is its own explicit action.
  await fetch(`${api.base}/panel/settings`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: api.admin },
    body: new URLSearchParams({ clear: 'translation.googleApiKey' }),
  })
  assert.equal(await api.container.settings.get('translation.googleApiKey'), '')
  assert.equal((await describe()).isSet, false)
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
