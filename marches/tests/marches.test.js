import test from 'node:test'
import assert from 'node:assert/strict'
import { createHttpClient } from '../src/scraper/httpClient.js'
import { createMarcheScraper } from '../src/scraper/marcheScraper.js'
import {
  parseMarcheList,
  parseMarcheDetail,
  parseFormState,
  parseTotal,
  detailUrl,
  POSTBACK,
} from '../src/scraper/parsers/marcheParser.js'
import { createTestContainer, createFetchStub, fixture } from './helpers.js'

const LISTING = fixture('live-ao-listing.html')
const DETAIL = fixture('live-ao-detail.html')

test('a listing row is read whole, not as the portal truncates it', () => {
  const { items } = parseMarcheList(LISTING)
  assert.equal(items.length, 3)

  const [first] = items
  assert.equal(first.source_id, '1031023')
  assert.equal(first.org_acronyme, 'l1f')
  assert.equal(first.reference, '01/2026')
  assert.equal(first.acheteur, 'GROUPEMENT DE COMMUNES SEDDINA POUR ENVIRONNEMENT')
  assert.equal(first.categorie, 'Services')
  assert.equal(first.procedure_type, "Appel d'offres ouvert")
  assert.equal(first.mode_passation, 'AOO')
  assert.equal(first.date_publication, '2026-08-06')
  assert.equal(first.date_limite, '2026-11-04')
  assert.equal(first.heure_limite, '11:00')
  assert.equal(first.lieu_execution, 'MAROC, TETOUAN')

  // The cell shows an ellipsised objet and the tooltip beside it holds the
  // whole sentence. Storing the cell's copy would end every objet in "…".
  assert.match(first.objet, /Tétouan\.$/)
  assert.doesNotMatch(first.objet, /…|\.\.\./)
})

test('the two identity values the detail page needs are both captured', () => {
  const { items } = parseMarcheList(LISTING)
  for (const item of items) {
    assert.ok(item.source_id, 'refConsultation')
    assert.ok(item.org_acronyme, 'orgAcronyme')
    assert.equal(item.detail_url, detailUrl(item.source_id, item.org_acronyme))
    assert.match(item.detail_url, /refConsultation=\d+&orgAcronyme=\w+/)
  }
})

test('the portal’s own total is read, not the page size', () => {
  assert.equal(parseTotal(LISTING), 100223)
  // 100k consultations behind three rows: the count must never be mistaken for
  // how many this page happened to carry.
  assert.notEqual(parseTotal(LISTING), parseMarcheList(LISTING).items.length)
})

test('the estimate comes off the detail page, which is where it is published', () => {
  const detail = parseMarcheDetail(DETAIL)
  assert.equal(detail.estimation_cents, 1_500_000_000)
})

test('the commission block is present but empty for an anonymous read', () => {
  const detail = parseMarcheDetail(DETAIL)
  // The portal emits the container and fills it only for a signed-in company
  // that bid on this consultation. Nobody can crawl the competitors' prices —
  // which is exactly the part of article 44 that stays a manual entry.
  assert.equal(detail.has_commission_block, true)
  assert.deepEqual(detail.commission_rows, [])
})

test('the whole hidden form state is carried into a postback', () => {
  const state = parseFormState(LISTING)
  // PRADO rebuilds the page it thinks you are on from this blob. Dropping it
  // returns page one for every request, which looks like a working crawl that
  // stores the same rows all night.
  assert.ok(state.PRADO_PAGESTATE)
  assert.ok('PRADO_POSTBACK_TARGET' in state)
  assert.equal(POSTBACK.next, 'ctl0$CONTENU_PAGE$resultSearch$PagerTop$ctl2')
  assert.equal(POSTBACK.pageSize, 'ctl0$CONTENU_PAGE$resultSearch$listePageSizeTop')
})

/** A scraper wired to the fixtures, with the calls it makes recorded. */
async function crawler(options = {}) {
  const stub = createFetchStub([
    [/EntrepriseDetailsConsultation/, DETAIL],
    [/EntrepriseAdvancedSearch/, LISTING],
  ])
  const http = createHttpClient({ fetchImpl: stub, delayMs: 0 })
  const container = await createTestContainer({ http })
  // Wired the way the runner wires it, documents included — a helper that
  // omits a collaborator tests a scraper nobody runs.
  const scraper = createMarcheScraper({
    http,
    consultations: container.repositories.consultations,
    documents: container.repositories.documents,
  })
  const stats = await scraper.scrape({ maxPages: 1, fetchDetails: true, until: () => true, ...options })
  return { stats, container, calls: stub.calls ?? [] }
}

test('a crawl stores every row and fills in the estimate each one is missing', async () => {
  const { stats, container } = await crawler()

  assert.equal(stats.itemsFound, 3)
  assert.equal(stats.itemsCreated, 3)
  assert.equal(stats.detailsFetched, 3)
  assert.equal(stats.estimatesFound, 3)
  assert.deepEqual(stats.errors, [])
  assert.equal(stats.total, 100223)

  const { rows } = await container.repositories.consultations.search({}, { limit: 10, offset: 0 })
  assert.equal(rows.length, 3)
  for (const row of rows) {
    assert.ok(row.estimation_cents > 0, `${row.reference} has an estimate`)
    assert.ok(row.org_acronyme, `${row.reference} keeps its buying entity`)
  }
})

test('a second crawl re-reads nothing it already has an estimate for', async () => {
  const { container } = await crawler()
  const scraper = createMarcheScraper({ http: createHttpClient({
    fetchImpl: createFetchStub([
      [/EntrepriseDetailsConsultation/, DETAIL],
      [/EntrepriseAdvancedSearch/, LISTING],
    ]),
    delayMs: 0,
  }), consultations: container.repositories.consultations, documents: container.repositories.documents })

  const again = await scraper.scrape({ maxPages: 1, fetchDetails: true, until: () => true })
  assert.equal(again.itemsCreated, 0, 'the same consultations are not duplicated')
  // The detail page is the expensive half of the crawl, and re-reading a page
  // whose estimate is already stored spends a request to learn nothing.
  assert.equal(again.detailsFetched, 0)
})

test('the crawl stops at the end of the open window rather than at a page count', async () => {
  // The listing runs deadline-descending, so the open marchés lead and the ones
  // closing soonest sit at the *end* of that run. A crawl that stopped early
  // would drop the most urgent, not the least interesting — which is the shape
  // of the bug that once cost the bons de commande crawl every avis closing
  // inside a day.
  const { stats } = await crawler({ until: (row) => row.date_limite < '2026-11-03', maxPages: 5 })
  assert.equal(stats.pagesScraped, 1, 'stopped on the page that reached the boundary')
})

test('every screen the sidebar offers actually renders', async (t) => {
  // The gap that let a 500 through: nothing opened a project page, so a route
  // still asking for a price benchmark — deleted with the awards it was
  // computed from — was only found by hand. A sidebar link that 500s is worse
  // than one that is missing, so every one of them is opened here.
  const { createApp } = await import('../src/app.js')
  const { startTestServer } = await import('./helpers.js')
  const jwt = (await import('jsonwebtoken')).default

  const { container } = await crawler()
  const server = await startTestServer(createApp(container))
  t.after(() => server.close())

  const token = jwt.sign(
    { sub: '1', email: 'you@civictrust.ma', role: 'admin', name: 'You', svc: ['marches'] },
    process.env.JWT_SECRET,
    { expiresIn: '12h' },
  )
  const open = (path) =>
    fetch(`${server.base}${path}`, { redirect: 'manual', headers: { cookie: `mp_token=${token}` } })

  const html = await (await open('/panel')).text()
  const nav = html.slice(html.indexOf('<nav>'), html.indexOf('</nav>'))
  const hrefs = [...nav.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1])
  // The sidebar also links out — to the sibling service and the administration
  // console, which are other origins. Those are somebody else's to answer for.
  const links = hrefs.filter((href) => href.startsWith('/'))
  // Named rather than counted: a count passes just as happily when the wrong
  // five screens are there, and it has to be edited every time one moves.
  for (const expected of ['/panel', '/panel/today', '/panel/reference-price', '/panel/favorites']) {
    assert.ok(links.includes(expected), `${expected} is offered`)
  }
  assert.ok(hrefs.some((href) => href.startsWith('http')), 'and there is a way out of this service')

  const row = await container.db.get('SELECT id FROM consultations LIMIT 1')
  for (const path of [...links, `/panel/consultations/${row.id}`]) {
    const response = await open(path)
    assert.ok(response.status < 400, `${path} answered ${response.status}`)
  }
})

test('the screens with nothing behind them on this portal are gone', async (t) => {
  const { createApp } = await import('../src/app.js')
  const { startTestServer } = await import('./helpers.js')
  const jwt = (await import('jsonwebtoken')).default

  const { container } = await crawler()
  const server = await startTestServer(createApp(container))
  t.after(() => server.close())

  const token = jwt.sign(
    { sub: '1', email: 'you@civictrust.ma', role: 'admin', svc: ['marches'] },
    process.env.JWT_SECRET,
    { expiresIn: '12h' },
  )

  // An appel d'offres publishes no article breakdown on its consultation page —
  // the lots are inside the downloadable dossier — and its award appears later
  // as a separate résultat définitif notice nothing here crawls. Every screen
  // built on either could only ever render zeroes. The exclusion register goes
  // with them: it is a list of companies barred from winning, and nothing here
  // records who wins.
  for (const path of ['/panel/awards', '/panel/insights', '/panel/companies', '/panel/exclusions']) {
    const response = await fetch(`${server.base}${path}`, {
      redirect: 'manual',
      headers: { cookie: `mp_token=${token}` },
    })
    assert.equal(response.status, 404, `${path} is gone, not empty`)
  }

  const nav = (await (await fetch(`${server.base}/panel`, { headers: { cookie: `mp_token=${token}` } })).text())
  assert.doesNotMatch(nav, /\/panel\/(awards|insights|companies|exclusions)"/, 'and the sidebar does not offer them')
})

test('a crawl records what it actually did, so the canary is not lied to', async (t) => {
  const { createTestContainer: makeContainer, createFetchStub: stub, fixture: fx } = await import('./helpers.js')
  const { createHttpClient: http } = await import('../src/scraper/httpClient.js')

  const container = await makeContainer({
    http: http({
      fetchImpl: stub([
        [/EntrepriseDetailsConsultation/, fx('live-ao-detail.html')],
        [/EntrepriseAdvancedSearch/, fx('live-ao-listing.html')],
      ]),
      delayMs: 0,
    }),
  })

  const { job, stats } = await container.runner.run({ source: 'marches', maxPages: 1, fetchDetails: true })

  // The numbers on the job row are what the dashboard prints and what the
  // health canary judges. Left at zero, a crawl that had just stored three
  // thousand consultations reported "the last crawl found nothing at all" —
  // the service looked dead from outside while working perfectly.
  assert.ok(stats.itemsFound > 0, 'the run reports what it found')
  assert.equal(Number(job.items_found), stats.itemsFound, 'and the job row agrees')
  assert.equal(Number(job.items_created), stats.itemsCreated)
  assert.ok(Number(job.items_found) > 0, 'so the canary sees a crawl that worked')
})

test('every table has as many cells in a row as it has headers', async (t) => {
  // The bug this exists for: removing the Articles and Résultat columns took
  // their <th> and left two <td>. Six headers, eight cells — so every value
  // sat under the wrong heading, and the objet appeared beneath "Acheteur".
  // Nothing errored, the page rendered, and it read as a CSS problem.
  const { createApp } = await import('../src/app.js')
  const { startTestServer } = await import('./helpers.js')
  const jwt = (await import('jsonwebtoken')).default

  const { container } = await crawler()
  const server = await startTestServer(createApp(container))
  t.after(() => server.close())

  const token = jwt.sign(
    { sub: '1', email: 'you@civictrust.ma', role: 'admin', svc: ['marches'] },
    process.env.JWT_SECRET,
    { expiresIn: '12h' },
  )
  const row = await container.db.get('SELECT id FROM consultations LIMIT 1')

  for (const path of ['/panel', '/panel/today', `/panel/consultations/${row.id}`, '/panel/favorites']) {
    const html = await (await fetch(`${server.base}${path}?lang=fr`, { headers: { cookie: `mp_token=${token}` } })).text()

    for (const table of html.match(/<table[\s\S]*?<\/table>/g) ?? []) {
      const head = table.match(/<thead>[\s\S]*?<\/thead>/)?.[0]
      if (!head) continue
      const headers = (head.match(/<th\b/g) ?? []).length

      const body = table.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0] ?? ''
      for (const tr of body.match(/<tr>[\s\S]*?<\/tr>/g) ?? []) {
        // A colspan row is a deliberate "nothing here" message, not a data row.
        if (/colspan=/.test(tr)) continue
        const cells = (tr.match(/<td\b/g) ?? []).length
        assert.equal(cells, headers, `${path}: a row has ${cells} cells under ${headers} headers`)
      }
    }
  }
})

test('the documents the portal publishes are captured and named for what they are', async () => {
  const detail = parseMarcheDetail(DETAIL)
  const byKind = Object.fromEntries(detail.documents.map((d) => [d.kind, d]))

  // Two, and they are not the same kind of thing. The avis is a file that
  // downloads; the dossier is a request form — the portal wants to know who is
  // taking it before it hands it over.
  assert.ok(byKind.avis, 'the published notice')
  assert.ok(byKind.dce, 'the tender dossier')
  assert.match(byKind.avis.url, /^https:\/\/www\.marchespublics\.gov\.ma\//, 'absolute, so the link works from here')
  assert.match(byKind.dce.file_name, /Dossier de consultation/)
  // The label carries the size, which is worth keeping: a 54 MB dossier is a
  // different afternoon from a 400 KB one.
  assert.match(byKind.dce.file_name, /\d+[,.]\d+\s*[MK]o/)
  // The repository leaves created_at to the caller and it is NOT NULL.
  for (const doc of detail.documents) assert.ok(doc.created_at, `${doc.kind} carries a timestamp`)
})

test('a crawl stores the documents, with concurrent reads but serial writes', async (t) => {
  const { container } = await crawler()

  const rows = await container.db.all('SELECT consultation_id, kind FROM consultation_documents ORDER BY consultation_id, kind')
  assert.equal(rows.length, 6, 'two documents for each of three consultations')

  // The bug this guards: the detail pass fetches with two workers, and the
  // documents write opens a transaction. Two overlapping transactions on one
  // SQLite connection fail with "no such savepoint", so a row was lost every
  // run. Reads are concurrent; writes are not.
  const { stats } = await crawler()
  assert.deepEqual(stats.errors, [], 'no savepoint collisions')
})

test('a project page states the band a bid has to land in', async (t) => {
  const { createApp } = await import('../src/app.js')
  const { startTestServer } = await import('./helpers.js')
  const jwt = (await import('jsonwebtoken')).default

  const { container } = await crawler()
  const server = await startTestServer(createApp(container))
  t.after(() => server.close())

  const token = jwt.sign(
    { sub: '1', email: 'you@civictrust.ma', role: 'admin', svc: ['marches'] },
    process.env.JWT_SECRET,
    { expiresIn: '12h' },
  )
  const row = await container.db.get(
    "SELECT id FROM consultations WHERE estimation_cents IS NOT NULL AND categorie = 'Services' LIMIT 1",
  )
  const html = await (
    await fetch(`${server.base}/panel/consultations/${row.id}?lang=fr`, { headers: { cookie: `mp_token=${token}` } })
  ).text()

  // 15 000 000 as Services: floor -25%, ceiling +20%. Asymmetric, which is the
  // detail every other calculator gets wrong — and it is computed here from
  // what the crawler already read, with nobody entering anything.
  assert.match(html, /11\.250\.000,00/, 'the floor')
  assert.match(html, /18\.000\.000,00/, 'the ceiling')
  assert.match(html, /−25 %/)
  assert.match(html, /\+20 %/)

  // And the limit is stated rather than implied: the reference price itself
  // needs the competitors' offers, which this portal does not publish.
  assert.match(html, /offres des concurrents/)
})
