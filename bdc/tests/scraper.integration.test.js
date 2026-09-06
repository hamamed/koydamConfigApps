import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestContainer, createFetchStub, fixture } from './helpers.js'
import { createHttpClient } from '../src/scraper/httpClient.js'

/** Container wired to fixture HTML instead of the live portal. */
async function setup() {
  const fetchImpl = createFetchStub([
    [/consultation\/detail\/884512/, fixture('consultation-detail.html')],
    [/consultation\/detail\/884513/, fixture('consultation-detail-2.html')],
    [/resultat\/detail\//, fixture('result-detail.html')],
    [/consultation\/resultat/, fixture('results-page1.html')],
    [/page=2/, fixture('consultations-page2.html')],
    [/consultation\//, fixture('consultations-page1.html')],
  ])
  const http = createHttpClient({ fetchImpl, delayMs: 0 })
  return { ...(await createTestContainer({ http })), fetchImpl }
}

test('scrapes both sources and matches them by reference', async () => {
  const { runner, repositories } = await setup()

  const { stats, detail } = await runner.run({ source: 'all', maxPages: 5, fetchDetails: true })

  assert.equal(detail.consultations.itemsFound, 2)
  assert.equal(detail.consultations.itemsCreated, 2)
  assert.equal(detail.consultations.pagesScraped, 2, 'follows pagination until the portal runs out of rows')
  assert.equal(detail.results.itemsCreated, 2)

  // The consultation and its award share the reference AOO12/2026 and are linked.
  const consultation = await repositories.consultations.findByReference('AOO12/2026')
  const result = await repositories.results.findByReference('AOO12/2026')
  assert.ok(consultation)
  assert.equal(result.consultation_id, consultation.id)
  assert.ok(result.matched_at)
  assert.equal(consultation.has_result, 1)
  assert.equal(consultation.status, 'awarded')

  // MP99/2025 has an award but no consultation on this instance: it stays unmatched.
  const orphan = await repositories.results.findByReference('MP99/2025')
  assert.equal(orphan.consultation_id, null)
  assert.equal(detail.matching.unmatchedResults, 1)
  assert.equal(stats.matchesLinked, 1)

  // Detail pages contributed the article/lot breakdown.
  const articles = await repositories.articles.findByConsultationId(consultation.id)
  assert.equal(articles.length, 3)
  assert.equal(articles[0].unit_price_cents, 950_000)
  assert.equal(consultation.lots_count, 3, 'lots_count is derived from the stored articles')
  assert.equal(consultation.estimation_cents, 125_000_000, 'detail-only fields survive the listing pass')

  const lots = await repositories.results.findLots(result.id)
  assert.equal(lots.length, 3)
})

test('re-scraping is idempotent and does not duplicate rows', async () => {
  const { runner, repositories } = await setup()

  await runner.run({ source: 'consultations', maxPages: 5, fetchDetails: true })
  const second = await runner.run({ source: 'consultations', maxPages: 5, fetchDetails: true })

  assert.equal(second.detail.consultations.itemsCreated, 0)
  assert.equal(second.detail.consultations.itemsUnchanged, 2, 'unchanged rows are detected via the content hash')
  assert.equal(await repositories.consultations.countAll(), 2)
  assert.equal(await repositories.articles.countAll(), 5)

  // The detail-page fields must survive a listing-only pass, not be reset to null.
  const consultation = await repositories.consultations.findByReference('AOO12/2026')
  assert.equal(consultation.estimation_cents, 125_000_000)
  assert.equal(consultation.qualification, 'Secteur 5 - Classe 3')
  assert.equal(consultation.lots_count, 3)
})

test('records every run in scrape_jobs and refuses concurrent runs of one source', async () => {
  const { runner, repositories } = await setup()

  await runner.run({ source: 'results', maxPages: 1, triggeredBy: 'test' })
  const [job] = await repositories.jobs.listRecent(1)

  assert.equal(job.source, 'results')
  assert.equal(job.status, 'success')
  assert.equal(job.triggered_by, 'test')
  assert.ok(job.finished_at)
  assert.ok(job.duration_ms >= 0)

  // A job stuck in `running` blocks a second run of the same source.
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

test('the matcher links results scraped before their consultation', async () => {
  const { runner, repositories } = await setup()

  // Results first: nothing to link to yet.
  await runner.run({ source: 'results', maxPages: 1, fetchDetails: false })
  assert.equal(await repositories.results.countUnmatched(), 2)

  // Consultations arrive later; the matching pass closes the gap.
  await runner.run({ source: 'consultations', maxPages: 5, fetchDetails: false })
  assert.equal(await repositories.results.countUnmatched(), 1)
})
