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

test('the awards tab lists results and links the matched ones', async (t) => {
  const api = await setup()
  t.after(() => api.close())

  const html = await (await api.page('/panel/awards', api.staff)).text()

  assert.match(html, /STE AMALIA DES ETOILES D/, 'the winner is shown')
  // Grouped, to the centime, with its unit — not the bare 8064 this used to
  // print, which is a number rather than a price.
  assert.match(html, /8\.064,00 MAD/, 'the amount is not shown as a price')
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

  const awards = await fetch(`${api.base}/api/export/awards.csv`, { headers: { cookie: api.staff } })
  assert.match((await awards.text()).split('\r\n')[0], /Attributaire/)
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
  assert.match(byHref['/panel/awards'], /circle cx="12" cy="8" r="6"/, 'Results carries the medal')
  assert.match(byHref['/panel/insights'], /rect x="7" y="13"/, 'Insights carries the bar chart')
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
  const get = await fetch(`${api.base}/login?next=/panel/awards`, { redirect: 'manual' })
  assert.equal(get.status, 302)
  assert.match(get.headers.get('location'), /\/login\?next=/, 'forwarded to a sign-in form')
  assert.match(decodeURIComponent(get.headers.get('location')), /\/panel\/awards$/, 'carrying where to come back to')

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

test('the list filters offer the values the data actually holds, and selecting one filters', async (t) => {
  const api = await setup()
  t.after(api.close)

  // What the three columns really contain, straight from the repository.
  const facets = await api.container.services.consultations.facets()
  assert.ok(facets.categories.length > 0, 'expected at least one category in the fixtures')
  assert.ok(facets.buyers.length > 0, 'expected at least one buyer in the fixtures')

  const html = await (await api.page('/panel', api.staff)).text()

  // All three are dropdowns, and each offers every value its column holds —
  // not a text box the reader has to guess the exact spelling into.
  ;['acheteur', 'categorie', 'lieuExecution'].forEach((id) => {
    assert.match(html, new RegExp(`<select id="${id}"[^>]*class="facet"`), `${id} is not a dropdown`)
  })
  facets.categories.forEach((f) => {
    assert.match(html, new RegExp(`<option value="${f.value}"`), `missing category option ${f.value}`)
  })
  // The dropdown is typeable because facet-search.ejs upgrades it in the
  // browser. Without the script shipping, this page is still usable but not
  // searchable, which is the whole of what was asked for.
  assert.match(html, /select\.facet/, 'the search enhancement did not ship with the page')

  const options = (id) => (html.split(`<select id="${id}"`)[1] || '').split('</select>')[0].match(/<option/g).length
  // Every value, plus the leading "any" row.
  assert.equal(options('acheteur'), facets.buyers.length + 1)
  assert.equal(options('lieuExecution'), facets.places.length + 1)

  // The point of offering a value is that choosing it narrows the list. A
  // dropdown of values that do not filter would look identical to this one.
  const chosen = facets.categories[0]
  const filtered = await api.container.services.consultations.search({ categorie: chosen.value }, { limit: 50, offset: 0 })
  assert.equal(filtered.total, chosen.count)
  assert.ok(filtered.data.every((row) => row.categorie === chosen.value))
})

test('coming back from a consultation returns to the listing that was left', async (t) => {
  const api = await setup()
  t.after(api.close)

  const facets = await api.container.services.consultations.facets()
  const search = `/panel?categorie=${encodeURIComponent(facets.categories[0].value)}&sort=acheteur%3Aasc&page=2`

  // Look at a filtered page 2 of the listing.
  const listing = await api.page(search, api.staff)
  assert.equal(listing.status, 200)
  const remembered = (listing.headers.getSetCookie?.() ?? [])
    .find((c) => c.startsWith('mp_list='))
  assert.ok(remembered, 'the listing was not remembered')

  // Follow a consultation, carrying the cookie the browser would carry.
  const cookie = `${api.staff}; ${remembered.split(';')[0]}`
  const detail = await api.page(`/panel/consultations/${api.consultationId}`, cookie)
  assert.equal(detail.status, 200)
  const html = await detail.text()

  // Back leads to the filtered page 2, not to a bare listing.
  const back = /<a class="btn secondary" href="([^"]+)"/.exec(html)
  assert.ok(back, 'no Back link on the detail screen')
  const target = back[1].replace(/&amp;/g, '&')
  assert.match(target, /^\/panel\?/)
  assert.match(target, new RegExp(`categorie=${encodeURIComponent(facets.categories[0].value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(target, /sort=acheteur%3Aasc/)
  assert.match(target, /page=2/)

  // The sidebar leads to the same place, so a later visit resumes too — the
  // href appears twice on the page: once in Back, once in the navigation.
  const href = `href="${back[1]}"`
  assert.ok(html.split(href).length - 1 >= 2, 'the sidebar does not resume the listing')
})

test('an unfiltered listing is not remembered, and clearing forgets one that was', async (t) => {
  const api = await setup()
  t.after(api.close)

  // Nothing worth remembering: no cookie is kept, so the sidebar stays plain.
  const plain = await api.page('/panel', api.staff)
  const set = (plain.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('mp_list='))
  assert.ok(!set || /mp_list=;/.test(set), 'an untouched listing should not be remembered')

  // A search is remembered; asking to clear it takes the memory with it.
  const listing = await api.page('/panel?categorie=Travaux', api.staff)
  const remembered = (listing.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('mp_list='))
  assert.ok(remembered && remembered.includes('categorie'), 'the search was not remembered')

  const cookie = `${api.staff}; ${remembered.split(';')[0]}`
  const cleared = await api.page('/panel?reset=1', cookie)
  assert.equal(cleared.status, 302)
  const dropped = (cleared.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('mp_list='))
  assert.ok(dropped && /mp_list=;/.test(dropped), 'clearing did not forget the search')
})

test('a buyer named in the listing opens the page the listing links to', async (t) => {
  const api = await setup()
  t.after(api.close)

  // The link is built from the listing, and followed exactly as rendered —
  // the earlier break was a page that rendered figures its own service had
  // stopped returning, which only a request that reaches the view can catch.
  const listing = await (await api.page('/panel', api.staff)).text()
  const href = /href="(\/panel\/buyers\/[^"]+)"/.exec(listing)
  assert.ok(href, 'the listing names no buyer')

  const response = await api.page(href[1].replace(/&amp;/g, '&'), api.staff)
  assert.equal(response.status, 200, `the buyer page answered ${response.status}`)

  const html = await response.text()
  assert.match(html, /class="stat"/, 'the buyer page rendered no figures')
  // Every figure it shows has to be a number or an em dash, never the string
  // an undefined field renders as.
  assert.ok(!/undefined/.test(html), 'the buyer page rendered an undefined field')

  // And it offers the way to the rest of that buyer's avis.
  assert.match(html, /href="\/panel\?acheteur=/)
})

test('the invoice appearance screen renders, saves, and previews a real PDF', async (t) => {
  const api = await setup()
  t.after(api.close)

  const page = await api.page('/panel/invoices/apparence', api.staff)
  assert.equal(page.status, 200)
  const html = await page.text()
  ;['classique', 'moderne', 'epure'].forEach((key) => {
    assert.match(html, new RegExp(`value="${key}"`), `${key} is not offered`)
  })
  assert.match(html, /name="logo"/, 'there is nowhere to put a logo')
  assert.ok(!/undefined/.test(html), 'the screen rendered an undefined field')

  // The preview is drawn on the page, showing the template that is saved —
  // the point of it is choosing by looking rather than by downloading.
  assert.match(html, /id="sheet"/, 'the screen shows no preview')
  assert.match(html, /class="sheet tpl-classique"/, 'the preview ignores the saved template')
  assert.match(html, /Établie avec CivicTrust/, 'the preview omits the mark the PDF carries')

  // Saving a choice, and reading it back on the invoices the person issues.
  const saved = await api.page('/panel/invoices/apparence', api.staff, {
    method: 'POST',
    headers: { cookie: api.staff, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      template: 'moderne', density: 'compact', accent: '#8a1f4b',
      companyName: 'Atelier Nour', logoScale: '1.2',
    }).toString(),
  })
  assert.equal(saved.status, 302)
  const staff = await api.container.db.get('SELECT id FROM users WHERE email = ?', ['staff@test.ma'])
  const stored = await api.container.services.invoiceBranding.get(staff.id)
  assert.equal(stored.template, 'moderne')
  assert.equal(stored.accent, '#8a1f4b')
  assert.equal(stored.company_name, 'Atelier Nour')

  // Re-opened, the preview shows what was just chosen.
  const again = await (await api.page('/panel/invoices/apparence', api.staff)).text()
  assert.match(again, /class="sheet tpl-moderne"/, 'the preview did not follow the saved template')
  assert.match(again, /--accent:#8a1f4b/, 'the preview did not take the saved colour')

  // The preview is a PDF, not a page describing one.
  const preview = await api.page('/panel/invoices/apparence/apercu.pdf', api.staff)
  assert.equal(preview.status, 200)
  assert.equal(preview.headers.get('content-type'), 'application/pdf')
  const bytes = Buffer.from(await preview.arrayBuffer())
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-')
  assert.ok(bytes.includes('%%EOF'), 'the preview was never finished')

  // A colour we cannot draw is refused on the way in, not inside a stream.
  const bad = await api.page('/panel/invoices/apparence', api.staff, {
    method: 'POST',
    headers: { cookie: api.staff, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ template: 'classique', accent: 'rouge' }).toString(),
  })
  assert.equal(bad.status, 400)
})

test('every price on a screen is grouped, to the centime, and carries its unit', async (t) => {
  const api = await setup()
  t.after(api.close)

  // The awards table is the densest column of prices in the panel.
  const html = await (await api.page('/panel/awards', api.staff)).text()

  // Pull what sits in the money cells and check each one is a price rather
  // than a bare figure. A single unformatted amount is the bug this guards:
  // the same number appeared as "36000" on one screen and "36 000,00 MAD" on
  // another, because each view formatted its own.
  const cells = [...html.matchAll(/<td[^>]*class="[^"]*money[^"]*"[^>]*>([\s\S]*?)<\/td>/g)]
    .map(([, cell]) => cell.replace(/<[^>]*>/g, '').trim())
    .filter((cell) => cell && cell !== '—')
  assert.ok(cells.length > 0, 'no money cells were found to check')

  cells.forEach((cell) => {
    assert.match(cell, /^\d{1,3}(\.\d{3})*,\d{2} [A-Z]{3}$/, `"${cell}" is not written as a price`)
  })
})

test('an amount that is missing prints as a dash, not as zero or nothing', async () => {
  const { formatMoney } = await import('../src/utils/money.js')
  assert.equal(formatMoney(null), '—')
  assert.equal(formatMoney(undefined), '—')
  assert.equal(formatMoney(''), '—')
  assert.equal(formatMoney('not a number'), '—')
  // Zero is a real amount and must not be swallowed by the same check.
  assert.equal(formatMoney(0), '0,00 MAD')
  assert.equal(formatMoney(1250000), '1.250.000,00 MAD')
  assert.equal(formatMoney(36000.5, 'EUR'), '36.000,50 EUR')
})

test('a long price is set smaller, and a short one is never shrunk for it', async () => {
  const { formatMoney, priceClass } = await import('../src/utils/money.js')

  const SIZES = { '': 24, 'price-m': 19, 'price-s': 14, 'price-xs': 11 }
  const amounts = [999, 1968, 19968, 250000, 12345678.9, 7702995653.72, 1234567890123.45]

  // Sizes only ever go down as prices get longer. A step out of order would
  // set a longer figure larger than a shorter one, which is how a price ends
  // up wider than the box that holds it.
  let previous = Infinity
  amounts.forEach((amount) => {
    const size = SIZES[priceClass(formatMoney(amount))]
    assert.ok(size !== undefined, `${amount} produced an unknown size class`)
    assert.ok(size <= previous, `${formatMoney(amount)} is set larger than a shorter price`)
    previous = size
  })

  // An ordinary amount keeps the full size; only long ones pay.
  assert.equal(priceClass(formatMoney(999)), '')
  assert.equal(priceClass(formatMoney(1234567890123.45)), 'price-xs')
  // And a missing amount is not a long string.
  assert.equal(priceClass(formatMoney(null)), '')
})
