import { serializeRow, serializeRows } from './serializers.js'
import { NotFoundError, ValidationError } from '../utils/errors.js'
import { SOURCES } from '../scraper/runner.js'
import { logger } from '../utils/logger.js'

const log = logger.child('[admin]')

/**
 * Admin-panel operations: dashboard counters, manual scrape triggers and CRUD
 * over the scraped records.
 */
export function createAdminService({ consultations, articles, documents, results, invoices, users, jobs, runner, settings }) {
  /** Counters and recent activity for the dashboard. */
  async function dashboard() {
    const [
      consultationCount,
      articleCount,
      documentCount,
      resultCount,
      invoiceCount,
      userCount,
      cancelled,
      unmatched,
      ambiguous,
      pendingDetails,
      recentJobs,
      lastRun,
      runAt,
      sinceDays,
    ] = await Promise.all([
      consultations.countAll(),
      articles.countAll(),
      documents.countAll(),
      results.countAll(),
      invoices.countAll(),
      users.countAll(),
      consultations.countCancelled(),
      results.countUnmatched(),
      results.countAmbiguous(),
      consultations.countPendingDetails(),
      jobs.listRecent(10),
      jobs.lastFinished(),
      settings.get('scraper.dailyRunAt'),
      settings.get('scraper.dailySinceDays'),
    ])

    return {
      counts: {
        consultations: consultationCount,
        articles: articleCount,
        results: resultCount,
        invoices: invoiceCount,
        users: userCount,
        documents: documentCount,
        cancelled,
        unmatchedResults: unmatched,
        ambiguousResults: ambiguous,
        pendingDetails,
      },
      lastRun: describeRun(lastRun),
      schedule: { runAt, sinceDays, nextRunAt: nextRunAfter(runAt) },
      matchRate: resultCount > 0 ? Number((((resultCount - unmatched) / resultCount) * 100).toFixed(1)) : null,
      recentJobs: serializeRows(recentJobs),
      runningJob: (await jobs.findRunning()) ?? null,
    }
  }

  /**
   * The last finished crawl, flattened for the dashboard: when it ran, how long
   * it took, and how many projects and awards it actually brought in.
   */
  function describeRun(job) {
    if (!job) return null
    const detail = safeParse(job.detail_json)
    return {
      id: job.id,
      source: job.source,
      status: job.status,
      triggeredBy: job.triggered_by,
      finishedAt: job.finished_at,
      durationMs: job.duration_ms,
      error: job.error_message,
      consultations: detail?.consultations ?? null,
      results: detail?.results ?? null,
      backfill: detail?.backfill ?? null,
      matchesLinked: job.matches_linked,
    }
  }

  /**
   * The next occurrence of the daily run, in UTC.
   *
   * Derived from a setting, not from systemd: the app has no business shelling
   * out to `systemctl`, and reading it would tie the panel to one init system.
   * The setting mirrors bdc-scrape.timer and is labelled as scheduled, not
   * observed.
   */
  function nextRunAfter(runAt, now = new Date()) {
    const [hours, minutes] = String(runAt ?? '').split(':').map(Number)
    if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null

    const next = new Date(now)
    next.setUTCHours(hours, minutes, 0, 0)
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1)
    return next.toISOString()
  }

  const safeParse = (value) => {
    try {
      return value ? JSON.parse(value) : null
    } catch {
      return null
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
