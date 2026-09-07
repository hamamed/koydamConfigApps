import { logger } from '../utils/logger.js'

const log = logger.child('[scraper:health]')

/**
 * A canary on the crawler.
 *
 * Every failure this scraper has had was silent. The parsers returned nothing
 * when the portal moved from tables to cards; the filters were sent under the
 * wrong form root and did nothing for weeks; a WAF 403 arrived looking exactly
 * like "no results". In each case the job finished, reported success, and the
 * data quietly stopped arriving.
 *
 * So health is judged on what a run *produced*, not on whether it threw:
 *
 *  - a crawl that finds nothing at all, when the catalogue is not empty;
 *  - a sharp drop against what recent runs found;
 *  - fields that stop being parsed — a listing row with no buyer or no deadline
 *    means the labels moved again;
 *  - a growing detail backlog, which means detail pages are failing.
 */
export const SEVERITY = Object.freeze({ OK: 'ok', WARN: 'warn', FAIL: 'fail' })

/** Below this share of a recent run's yield, a crawl is suspicious. */
const YIELD_DROP_RATIO = 0.4
/** Below this share of rows carrying a field, the parser has probably broken. */
const FIELD_FILL_FLOOR = 0.8
const BACKLOG_CEILING = 500

export function createHealthService({ consultations, results, jobs, db }) {
  /**
   * @returns {Promise<{severity: string, checks: Array<{id, severity, detail}>}>}
   */
  async function check() {
    const checks = []
    const add = (id, severity, detail) => checks.push({ id, severity, detail })

    const recent = await jobs.listRecent(20)
    const crawls = recent.filter((job) => job.source !== 'backfill' && job.status === 'success')
    const [last] = crawls

    if (!last) {
      add('lastRun', SEVERITY.WARN, 'no successful crawl on record')
    } else {
      const ageHours = (Date.now() - Date.parse(last.finished_at ?? last.started_at)) / 3_600_000
      // The schedule is daily; two days of silence means the timer is not firing.
      add(
        'freshness',
        ageHours > 48 ? SEVERITY.FAIL : ageHours > 26 ? SEVERITY.WARN : SEVERITY.OK,
        `last crawl ${Math.round(ageHours)}h ago`,
      )

      const failures = recent.filter((job) => job.status === 'failed').length
      add('failures', failures > 2 ? SEVERITY.WARN : SEVERITY.OK, `${failures} failed job(s) in the last 20`)

      const catalogue = await consultations.countAll()
      if (catalogue > 0 && last.items_found === 0) {
        add('yield', SEVERITY.FAIL, 'the last crawl found nothing at all')
      } else {
        const others = crawls.slice(1, 6).map((job) => job.items_found).filter((n) => n > 0)
        const typical = others.length > 0 ? others.reduce((a, b) => a + b, 0) / others.length : 0
        const dropped = typical > 0 && last.items_found < typical * YIELD_DROP_RATIO
        add(
          'yield',
          dropped ? SEVERITY.WARN : SEVERITY.OK,
          `last crawl found ${last.items_found}${typical ? `, recent average ${Math.round(typical)}` : ''}`,
        )
      }
    }

    // Parser health: a listing row always carries these. If they stop arriving,
    // the labels moved and everything downstream is quietly emptier.
    for (const [id, sql] of [
      ['fieldAcheteur', 'SELECT COUNT(*) AS total, SUM(CASE WHEN acheteur IS NULL THEN 1 ELSE 0 END) AS missing FROM consultations'],
      ['fieldDeadline', 'SELECT COUNT(*) AS total, SUM(CASE WHEN date_limite IS NULL THEN 1 ELSE 0 END) AS missing FROM consultations'],
      ['fieldWinner', "SELECT COUNT(*) AS total, SUM(CASE WHEN attributaire IS NULL AND result_status = 'attribue' THEN 1 ELSE 0 END) AS missing FROM consultation_results"],
    ]) {
      const row = await db.get(sql)
      const total = Number(row.total)
      if (total === 0) continue
      const filled = (total - Number(row.missing ?? 0)) / total
      add(
        id,
        filled < FIELD_FILL_FLOOR ? SEVERITY.WARN : SEVERITY.OK,
        `${Math.round(filled * 100)}% of ${total} rows carry it`,
      )
    }

    const backlog = await consultations.countPendingDetails()
    add(
      'detailBacklog',
      backlog > BACKLOG_CEILING ? SEVERITY.WARN : SEVERITY.OK,
      `${backlog} detail page(s) unread`,
    )

    const severity = checks.some((c) => c.severity === SEVERITY.FAIL)
      ? SEVERITY.FAIL
      : checks.some((c) => c.severity === SEVERITY.WARN)
        ? SEVERITY.WARN
        : SEVERITY.OK

    if (severity !== SEVERITY.OK) {
      log.warn('crawler health degraded', { severity, problems: checks.filter((c) => c.severity !== SEVERITY.OK) })
    }
    return { severity, checks, unmatchedResults: await results.countUnmatched() }
  }

  return { check }
}
