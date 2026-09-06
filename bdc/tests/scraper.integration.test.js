import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestContainer, createFetchStub, fixture } from './helpers.js'
import { createHttpClient } from '../src/scraper/httpClient.js'

/** Container wired to pages captured from the live portal instead of the network. */
async function setup() {
  const fetchImpl = createFetchStub([
    [/consultation\/show\//, fixture('live-consultation-detail.html')],
    [/consultation\/resultat/, fixture('live-results-matching.html')],
    [/page=2/, fixture('live-consultations-empty.html')],
    [/consultation\//, fixture('live-consultations.html')],
  ])
  const http = createHttpClient({ fetchImpl, delayMs: 0 })
  return { ...(await createTestContainer({ http })), fetchImpl }
}

test('scrapes both sources and matches them by reference', async () => {
  const { runner, repositories } = await setup()

  const { stats, detail } = await runner.run({ source: 'all', maxPages: 2, fetchDetails: false })

  assert.equal(detail.consultations.itemsFound, 10)
  assert.equal(detail.consultations.itemsCreated, 10)
  assert.equal(detail.consultations.pagesScraped, 2, 'follows pagination until a page comes back empty')
  assert.equal(detail.results.itemsCreated, 10)

  // 53/2026 is published on both listings, so it is the pair the matcher links.
  const consultation = await repositories.consultations.findBySourceId('375169')
  const [award] = await repositories.results.findByReference('53/2026')
  assert.ok(consultation && award)
  assert.equal(award.consultation_id, consultation.id, 'the link is a foreign key, not a string match')
  assert.ok(award.matched_at)
  assert.equal(consultation.has_result, 1, 'the award is linked to its consultation')

  // Status precedence: a withdrawn avis stays "annule" even once an award is
  // linked to it. Being cancelled is terminal and outranks every other state.
  assert.equal(consultation.is_cancelled, 1)
  assert.equal(consultation.status, 'annule')
  assert.equal(stats.matchesLinked, 1)

  // The other nine awards refer to consultations this instance never saw. They
  // stay unmatched rather than being guessed at.
  assert.equal(detail.matching.unmatchedResults, 9)
  const [orphan] = await repositories.results.findByReference('31/2026')
  assert.equal(orphan.consultation_id, null)
})

test('the detail pass adds the article breakdown the listing does not carry', async () => {
  const { runner, repositories } = await setup()
  await runner.run({ source: 'consultations', maxPages: 1, fetchDetails: false })

  const before = await repositories.consultations.findBySourceId('375169')
  assert.equal(before.categorie, null, 'the listing card has no category')
  assert.equal(before.lots_count, 0)

  const { articles } = await runner.consultationScraper.scrapeDetail(before)

  assert.equal(articles.length, 19)
  const after = await repositories.consultations.findBySourceId('375169')
  assert.equal(after.categorie, 'Fournitures')
  assert.equal(after.date_publication, '2026-08-31')
  assert.equal(after.lots_count, 19)
  assert.equal(after.date_annulation, '2026-09-01')
})

test('re-scraping is idempotent and does not duplicate rows', async () => {
  const { runner, repositories } = await setup()

  await runner.run({ source: 'consultations', maxPages: 2, fetchDetails: false })
  const consultation = await repositories.consultations.findBySourceId('375169')
  await runner.consultationScraper.scrapeDetail(consultation)

  const second = await runner.run({ source: 'consultations', maxPages: 2, fetchDetails: false })

  assert.equal(second.detail.consultations.itemsCreated, 0)
  assert.equal(second.detail.consultations.itemsUnchanged, 10, 'unchanged rows are detected via the content hash')
  assert.equal(await repositories.consultations.countAll(), 10)
  assert.equal(await repositories.articles.countAll(), 19)

  // A listing pass must not erase what the detail pass captured.
  const after = await repositories.consultations.findBySourceId('375169')
  assert.equal(after.categorie, 'Fournitures')
  assert.equal(after.lots_count, 19)

  // The two sources disagree about the execution location — the card says
  // "AL HOCEIMA", the detail page "MAROC, KHENIFRA" — so once the detail page
  // has described a row, the listing may only fill gaps. Without that, each pass
  // overwrote the other and every crawl rewrote the same rows forever.
  assert.equal(after.lieu_execution, 'MAROC, KHENIFRA')
  assert.ok(after.detail_scraped_at)

  const third = await runner.run({ source: 'consultations', maxPages: 2, fetchDetails: false })
  assert.equal(third.detail.consultations.itemsUpdated, 0, 'a settled row is never rewritten')
  assert.equal(third.detail.consultations.itemsUnchanged, 10)
})

test('records every run in scrape_jobs and refuses concurrent runs of one source', async () => {
  const { runner, repositories } = await setup()

  await runner.run({ source: 'results', maxPages: 1, triggeredBy: 'test', fetchDetails: false })
  const [job] = await repositories.jobs.listRecent(1)

  assert.equal(job.source, 'results')
  assert.equal(job.status, 'success')
  assert.equal(job.triggered_by, 'test')
  assert.ok(job.finished_at)
  assert.ok(job.duration_ms >= 0)

  await repositories.jobs.start({ source: 'results', triggeredBy: 'test' })
  await assert.rejects(() => runner.run({ source: 'results' }), /already running/)
})

test('a failing page marks the job failed and surfaces the error', async () => {
  const { runner, repositories } = await createTestContainer({
    http: createHttpClient({
      fetchImpl: async () => {
        throw new Error('connection reset')
      },
      delayMs: 0,
      maxRetries: 1,
    }),
  })

  await assert.rejects(() => runner.run({ source: 'consultations' }))
  const [job] = await repositories.jobs.listRecent(1)
  assert.equal(job.status, 'failed')
  assert.match(job.error_message, /Failed to fetch/)
})

test('the matcher derives status from the facts on record', async () => {
  const { runner, repositories } = await setup()
  await runner.run({ source: 'consultations', maxPages: 1, fetchDetails: false })

  const [open] = await repositories.consultations.findByReference('03/2026')
  assert.equal(open.is_cancelled, 0)
  assert.equal(open.status, 'open', 'its deadline of 2026-09-16 has not passed')

  const [cancelled] = await repositories.consultations.findByReference('6/2026')
  assert.equal(cancelled.status, 'annule')

  // An explicit date rather than "now", so the assertion does not change meaning
  // as the fixture's deadlines age past today.
  await repositories.consultations.deriveStatus('2027-01-01')
  assert.equal((await repositories.consultations.findByReference('03/2026'))[0].status, 'closed')
  assert.equal(
    (await repositories.consultations.findByReference('6/2026'))[0].status,
    'annule',
    'a cancelled avis does not become merely closed',
  )

  // A listing pass must never reset a status the matcher derived.
  await runner.run({ source: 'consultations', maxPages: 1, fetchDetails: false })
  assert.equal((await repositories.consultations.findByReference('6/2026'))[0].status, 'annule')
})

test('an ambiguous key is left unlinked rather than guessed', async () => {
  const fetchImpl = createFetchStub([
    [/consultation\/show\//, fixture('live-consultation-detail.html')],
    [/consultation\/resultat/, fixture('live-results-matching.html')],
    [/page=2/, fixture('live-consultations-empty.html')],
    [/consultation\//, fixture('live-consultations-ambiguous.html')],
  ])
  const { runner, repositories } = await createTestContainer({
    http: createHttpClient({ fetchImpl, delayMs: 0 }),
  })

  const { detail } = await runner.run({ source: 'all', maxPages: 1, fetchDetails: false })

  // Two consultations share (reference, buyer) under different portal ids, so
  // the award for 53/2026 cannot be attributed to either. Attaching it to the
  // wrong one would corrupt every invoice built from that consultation.
  const [award] = await repositories.results.findByReference('53/2026')
  assert.equal(award.consultation_id, null)
  assert.equal(detail.matching.ambiguousResults, 1)
  assert.equal(detail.matching.matchesLinked, 0)
})

test('the detail backlog is worked through until it is empty', async () => {
  const { runner, repositories } = await setup()
  await runner.run({ source: 'consultations', maxPages: 1, fetchDetails: false })

  assert.equal(await repositories.consultations.countPendingDetails(), 10)

  const stats = await runner.consultationScraper.backfillDetails({ batchSize: 4 })

  assert.equal(stats.consultationsProcessed, 10, 'every consultation gets its detail page read')
  assert.equal(await repositories.consultations.countPendingDetails(), 0)
  assert.ok(stats.articlesSaved > 0)

  // Re-running is a no-op: the backlog is empty.
  const again = await runner.consultationScraper.backfillDetails()
  assert.equal(again.consultationsProcessed, 0)
})

test('the matcher links awards scraped before their consultation', async () => {
  const { runner, repositories } = await setup()

  await runner.run({ source: 'results', maxPages: 1, fetchDetails: false })
  assert.equal(await repositories.results.countUnmatched(), 10)

  await runner.run({ source: 'consultations', maxPages: 1, fetchDetails: false })
  assert.equal(await repositories.results.countUnmatched(), 9)
})

test('a 403 from the portal is reported rather than parsed as an empty page', async () => {
  // The portal sits behind a WAF that answers 403 to an unrecognised client.
  // Treating that as "no results" would quietly empty the catalogue.
  const { runner } = await createTestContainer({
    http: createHttpClient({
      fetchImpl: async (url) => ({
        ok: false,
        status: 403,
        url: String(url),
        headers: { getSetCookie: () => [] },
        text: async () => 'Forbidden',
      }),
      delayMs: 0,
      maxRetries: 1,
    }),
  })

  await assert.rejects(() => runner.run({ source: 'consultations' }), /403/)
})

test('a detail re-read reaches rows scraped before a field existed', async () => {
  const { runner, repositories } = await setup()
  await runner.run({ source: 'consultations', maxPages: 1, fetchDetails: false })
  await runner.consultationScraper.backfillDetails()

  assert.equal(await repositories.consultations.countPendingDetails(), 0)
  const before = await repositories.documents.countAll()
  assert.ok(before > 0, 'attachments were captured')

  // Simulate rows read before the parser knew about attachments.
  await repositories.documents.replaceForConsultation(
    (await repositories.consultations.findBySourceId('375169')).id,
    [],
  )

  // The plain backfill will not revisit them: it only looks at unread pages.
  const untouched = await runner.backfillDetails({})
  assert.equal(untouched.stats.consultationsProcessed, 0)

  // Asking for a refresh does.
  const refreshed = await runner.backfillDetails({ refreshAll: true })
  assert.equal(refreshed.stats.consultationsProcessed, 10)
  assert.equal(await repositories.documents.countAll(), before)
})
