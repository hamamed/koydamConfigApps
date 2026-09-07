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
  const scraper = createMarcheScraper({ http, consultations: container.repositories.consultations })
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
  }), consultations: container.repositories.consultations })

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
