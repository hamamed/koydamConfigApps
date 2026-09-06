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

  async function finish(id, { status, stats = {}, error = null }) {
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
      finished_at: finishedAt,
      duration_ms: job ? new Date(finishedAt) - new Date(job.started_at) : null,
    })
    return db.get(statement.sql, statement.params)
  }

  const findById = (id) => db.get(`SELECT * FROM ${TABLE} WHERE id = ?`, [id])

  const listRecent = (limit = 20) =>
    db.all(`SELECT * FROM ${TABLE} ORDER BY started_at DESC LIMIT ?`, [limit])

  const findRunning = (source) =>
    db.get(`SELECT * FROM ${TABLE} WHERE source = ? AND status = 'running' ORDER BY started_at DESC`, [source])

  return { start, finish, findById, listRecent, findRunning }
}
