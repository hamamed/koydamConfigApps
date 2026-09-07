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

test('records every run, and lets only one crawl touch the portal at a time', async () => {
  const { runner, repositories } = await setup()

  await runner.run({ source: 'results', maxPages: 1, triggeredBy: 'test', fetchDetails: false })
  const [job] = await repositories.jobs.listRecent(1)

  assert.equal(job.source, 'results')
  assert.equal(job.status, 'success')
  assert.equal(job.triggered_by, 'test')
  assert.ok(job.finished_at)
  assert.ok(job.duration_ms >= 0)
  assert.ok(JSON.parse(job.detail_json).results, 'the per-source counts are kept')

  // Politeness is about the portal, not about our sources: the daily timer and
  // a hand-started full load are separate units and would otherwise overlap,
  // doubling the request rate at a public service. Any running crawl blocks.
  await repositories.jobs.start({ source: 'consultations', triggeredBy: 'test' })
  await assert.rejects(() => runner.run({ source: 'results' }), /already running/)
  await assert.rejects(() => runner.backfillDetails({}), /already running/)
})

test('a crawl abandoned by a killed process does not wedge the schedule', async () => {
  const { runner, repositories, db } = await setup()

  // A process killed mid-crawl leaves its row on 'running' forever.
  const stranded = await repositories.jobs.start({ source: 'all', triggeredBy: 'test' })
  const longAgo = new Date(Date.now() - 30 * 3600 * 1000).toISOString()
  await db.run('UPDATE scrape_jobs SET started_at = ? WHERE id = ?', [longAgo, stranded.id])

  // The next run closes it out and proceeds rather than refusing forever.
  await runner.run({ source: 'results', maxPages: 1, fetchDetails: false, triggeredBy: 'test' })

  const abandoned = await repositories.jobs.findById(stranded.id)
  assert.equal(abandoned.status, 'failed')
  assert.match(abandoned.error_message, /abandoned/)
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

test('an archival pass steps over a page that will not load, and resumes where it stopped', async (t) => {
  const container = await createTestContainer()
  t.after(() => container.db.close?.())

  // Page 2 refuses however many times it is retried; the pass must not end
  // there. The live archive crawl met exactly this at page 292 of 1,500 and
  // threw away 290 pages of work, and the portal was answering minutes later.
  let served = 0
  const http = createHttpClient({
    delayMs: 0,
    maxRetries: 1,
    fetchImpl: async (url) => {
      const page = Number(new URL(url).searchParams.get('page') ?? 1)
      served += 1
      if (page === 2) throw new Error('socket hang up')
      return {
        ok: true, status: 200, url: String(url),
        headers: { getSetCookie: () => [] },
        text: async () => fixture('live-results-matching.html'),
      }
    },
  })

  const { createResultScraper } = await import('../src/scraper/resultScraper.js')
  const scraper = createResultScraper({ http, results: container.repositories.results })
  const stats = await scraper.scrape({ startPage: 1, maxPages: 3, skipFailedPages: true, fetchDetails: false })

  assert.deepEqual(stats.pagesFailed, [2], 'the bad page is recorded, not swallowed')
  assert.equal(stats.pagesScraped, 2, 'the other two are read')
  assert.ok(stats.itemsFound > 0)
  assert.ok(served >= 3, 'and it really did try page 2')
})

test('a daily crawl still fails loudly on a page it cannot read', async (t) => {
  const container = await createTestContainer()
  t.after(() => container.db.close?.())

  const http = createHttpClient({
    delayMs: 0,
    maxRetries: 1,
    fetchImpl: async () => { throw new Error('socket hang up') },
  })
  const { createResultScraper } = await import('../src/scraper/resultScraper.js')
  const scraper = createResultScraper({ http, results: container.repositories.results })

  // Skipping is for archival passes. On the daily crawl a page that will not
  // load is the news, and swallowing it would be the silent failure this
  // project keeps being bitten by.
  await assert.rejects(() => scraper.scrape({ maxPages: 2, fetchDetails: false }), /Failed to fetch/)
})

test('a crawl stopped by hand stops blocking within the hour, not within the day', async (t) => {
  const container = await createTestContainer()
  t.after(() => container.db.close?.())
  const jobs = container.repositories.jobs

  const abandon = async (source, hoursAgo) => {
    const job = await jobs.start({ source, triggeredBy: 'test', params: {} })
    await container.db.run('UPDATE scrape_jobs SET started_at = ? WHERE id = ?', [
      new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString(), job.id,
    ])
    return job.id
  }

  // Every scheduled crawl is bounded by a 90-minute unit timeout, so one still
  // running after three hours is dead. A single twelve-hour window — calibrated
  // for the manual backfill — meant a slice stopped by hand held the guard shut
  // against twelve hourly slices after it, and the archive silently stopped
  // advancing.
  const stopped = await abandon('archive', 3)
  assert.equal(await jobs.expireStale(), 1)
  assert.equal((await jobs.findById(stopped)).status, 'failed')
  assert.equal(await jobs.findRunning(), undefined)

  // The full backfill really can run for hours, so it keeps its long rope.
  const backfill = await abandon('backfill', 3)
  assert.equal(await jobs.expireStale(), 0, 'a three-hour backfill is still working')
  assert.equal((await jobs.findById(backfill)).status, 'running')

  // But not an unlimited one.
  await container.db.run('UPDATE scrape_jobs SET started_at = ? WHERE id = ?', [
    new Date(Date.now() - 26 * 3600 * 1000).toISOString(), backfill,
  ])
  assert.equal(await jobs.expireStale(), 1)
  assert.equal((await jobs.findById(backfill)).status, 'failed')
})
