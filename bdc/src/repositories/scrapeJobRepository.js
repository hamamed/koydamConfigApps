import { getDb } from '../db/index.js'
import { buildInsert, buildUpdate } from '../db/sql.js'
import { nowIso } from '../utils/dates.js'

const TABLE = 'scrape_jobs'

export function createScrapeJobRepository(db = getDb()) {
  const start = async ({ source, triggeredBy = 'system', params = null }) => {
    const { sql, params: values } = buildInsert(TABLE, {
      source,
      status: 'running',
      triggered_by: triggeredBy,
      params_json: params ? JSON.stringify(params) : null,
      started_at: nowIso(),
    })
    return db.get(sql, values)
  }

  async function finish(id, { status, stats = {}, detail = null, error = null }) {
    const job = await db.get(`SELECT started_at FROM ${TABLE} WHERE id = ?`, [id])
    const finishedAt = nowIso()
    const statement = buildUpdate(TABLE, {
      id,
      status,
      pages_scraped: stats.pagesScraped ?? 0,
      items_found: stats.itemsFound ?? 0,
      items_created: stats.itemsCreated ?? 0,
      items_updated: stats.itemsUpdated ?? 0,
      matches_linked: stats.matchesLinked ?? 0,
      error_message: error,
      detail_json: detail ? JSON.stringify(detail) : null,
      finished_at: finishedAt,
      duration_ms: job ? new Date(finishedAt) - new Date(job.started_at) : null,
    })
    return db.get(statement.sql, statement.params)
  }

  const findById = (id) => db.get(`SELECT * FROM ${TABLE} WHERE id = ?`, [id])

  const listRecent = (limit = 20) =>
    db.all(`SELECT * FROM ${TABLE} ORDER BY started_at DESC LIMIT ?`, [limit])

  /** The most recent finished run, for the dashboard's "last crawl" panel. */
  const lastFinished = (source = null) =>
    db.get(
      `SELECT * FROM ${TABLE} WHERE finished_at IS NOT NULL${source ? ' AND source = ?' : ''}
       ORDER BY finished_at DESC LIMIT 1`,
      source ? [source] : [],
    )

  /**
   * Any crawl still marked running, of any source.
   *
   * Politeness is about the portal, not about our sources: two of our jobs
   * running at once doubles the request rate at a public government service.
   * The daily timer and a hand-started full load are separate systemd units and
   * would otherwise happily overlap.
   *
   * A job older than `staleAfterHours` is ignored — a process killed mid-crawl
   * leaves its row on 'running' forever, and that must not wedge the schedule.
   */
  function findRunning({ staleAfterHours = 12 } = {}) {
    const cutoff = new Date(Date.now() - staleAfterHours * 3600 * 1000).toISOString()
    return db.get(
      `SELECT * FROM ${TABLE} WHERE status = 'running' AND started_at > ? ORDER BY started_at DESC`,
      [cutoff],
    )
  }

  /** Closes out jobs left behind by a killed process, so they stop blocking. */
  /**
   * Releases the guard from a job whose process is gone.
   *
   * The window is per source because the jobs are not the same size. Every
   * scheduled crawl is bounded by its unit's TimeoutStartSec of 90 minutes, so
   * one still "running" after two hours is dead; the manual full backfill is
   * allowed a day, which is what it is for.
   *
   * A single window of twelve hours was calibrated for the backfill and applied
   * to everything, so a slice stopped by hand held the guard closed against
   * twelve hourly slices after it. Nothing failed — the archive simply stopped
   * advancing, which is the shape of problem this project keeps meeting.
   */
  const STALE_AFTER_HOURS = Object.freeze({ backfill: 25, default: 2 })

  const expireStale = async () => {
    const now = Date.now()
    const cutoff = (source) =>
      new Date(now - (STALE_AFTER_HOURS[source] ?? STALE_AFTER_HOURS.default) * 3600 * 1000).toISOString()

    const result = await db.run(
      `UPDATE ${TABLE} SET status = 'failed', error_message = 'abandoned — process ended before finishing',
              finished_at = ?
       WHERE status = 'running'
         AND ((source = 'backfill' AND started_at <= ?) OR (source <> 'backfill' AND started_at <= ?))`,
      [nowIso(), cutoff('backfill'), cutoff('default')],
    )
    return result.changes
  }

  return { start, finish, findById, listRecent, lastFinished, findRunning, expireStale }
}
