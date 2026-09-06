import { serializeRow, serializeRows } from './serializers.js'
import { NotFoundError, ValidationError } from '../utils/errors.js'
import { SOURCES } from '../scraper/runner.js'
import { logger } from '../utils/logger.js'

const log = logger.child('[admin]')

/**
 * Admin-panel operations: dashboard counters, manual scrape triggers and CRUD
 * over the scraped records.
 */
export function createAdminService({ consultations, articles, results, invoices, users, jobs, runner }) {
  /** Counters and recent activity for the dashboard. */
  async function dashboard() {
    const [consultationCount, articleCount, resultCount, invoiceCount, userCount, unmatched, ambiguous, pendingDetails, recentJobs] =
      await Promise.all([
        consultations.countAll(),
        articles.countAll(),
        results.countAll(),
        invoices.countAll(),
        users.countAll(),
        results.countUnmatched(),
        results.countAmbiguous(),
        consultations.countPendingDetails(),
        jobs.listRecent(10),
      ])

    return {
      counts: {
        consultations: consultationCount,
        articles: articleCount,
        results: resultCount,
        invoices: invoiceCount,
        users: userCount,
        unmatchedResults: unmatched,
        ambiguousResults: ambiguous,
        pendingDetails: pendingDetails,
      },
      matchRate: resultCount > 0 ? Number((((resultCount - unmatched) / resultCount) * 100).toFixed(1)) : null,
      recentJobs: serializeRows(recentJobs),
      runningJob: (await jobs.findRunning('all')) ?? (await jobs.findRunning('consultations')) ?? null,
    }
  }

  /**
   * Triggers a scrape. Long crawls are started in the background and tracked in
   * `scrape_jobs`, so the HTTP request returns immediately.
   * @param {{source?: string, filters?: object, maxPages?: number, fetchDetails?: boolean, wait?: boolean}} options
   */
  async function triggerScrape(options = {}, triggeredBy = 'admin') {
    const source = options.source ?? 'all'
    if (!SOURCES.includes(source)) throw new ValidationError(`source must be one of ${SOURCES.join(', ')}`)

    const task = runner.run({ ...options, source, triggeredBy })
    if (options.wait) return task

    task.catch((error) => log.error('background scrape failed', { source, message: error.message }))
    return { accepted: true, source, message: 'Scrape started; poll /admin/api/jobs for progress.' }
  }

  /** Re-runs only the reference matching pass, without any HTTP traffic. */
  const rematch = () => runner.matcher.run()

  const listJobs = async (limit) => serializeRows(await jobs.listRecent(limit))

  async function updateConsultation(id, patch) {
    const existing = await consultations.findById(id)
    if (!existing) throw new NotFoundError(`Consultation ${id}`)
    const allowed = pick(patch, [
      'objet', 'acheteur', 'categorie', 'nature_prestation', 'lieu_execution',
      'date_publication', 'date_limite', 'status', 'procedure_type',
    ])
    return serializeRow(await consultations.update(id, allowed))
  }

  async function deleteConsultation(id) {
    const existing = await consultations.findById(id)
    if (!existing) throw new NotFoundError(`Consultation ${id}`)
    await consultations.remove(id)
    return { id, deleted: true }
  }

  async function updateResult(id, patch) {
    const existing = await results.findById(id)
    if (!existing) throw new NotFoundError(`Result ${id}`)
    const allowed = pick(patch, [
      'objet', 'acheteur', 'attributaire', 'attributaire_ice',
      'montant_attribue_cents', 'date_attribution', 'result_status',
    ])
    return serializeRow(await results.update(id, allowed))
  }

  async function deleteResult(id) {
    const existing = await results.findById(id)
    if (!existing) throw new NotFoundError(`Result ${id}`)
    await results.remove(id)
    return { id, deleted: true }
  }

  /** Re-crawls a single consultation's detail page to refresh its articles. */
  async function refreshConsultationDetail(id) {
    const consultation = await consultations.findById(id)
    if (!consultation) throw new NotFoundError(`Consultation ${id}`)
    const { articles: stored } = await runner.consultationScraper.scrapeDetail(consultation)
    return { id: consultation.id, reference: consultation.reference, articles: serializeRows(stored) }
  }

  /**
   * Reads the detail page of every consultation that has never had one read.
   *
   * The listing card carries no category, no nature of service and no articles,
   * so a row is only half a record until this has run. Long crawls are started
   * in the background and tracked in `scrape_jobs`.
   */
  async function backfillDetails(options = {}, triggeredBy = 'admin') {
    const task = runner.backfillDetails({ ...options, triggeredBy })
    if (options.wait) return task
    task.catch((error) => log.error('background backfill failed', { message: error.message }))
    return {
      accepted: true,
      pending: await consultations.countPendingDetails(),
      message: 'Backfill started; poll /admin/api/jobs for progress.',
    }
  }

  const pick = (source, keys) =>
    Object.fromEntries(Object.entries(source ?? {}).filter(([key]) => keys.includes(key)))

  return {
    dashboard,
    triggerScrape,
    backfillDetails,
    rematch,
    listJobs,
    updateConsultation,
    deleteConsultation,
    updateResult,
    deleteResult,
    refreshConsultationDetail,
  }
}
