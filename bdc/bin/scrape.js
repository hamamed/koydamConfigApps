#!/usr/bin/env node
/**
 * CLI entry point for the scraper — the same code path the admin panel triggers.
 *
 *   npm run scrape -- --source=consultations --max-pages=3
 *   npm run scrape -- --source=results --start-page=292 --max-pages=1200  resume a deep pass
 *   npm run scrape -- --source=results --filter.acheteur=ANCFCC
 *   npm run scrape -- --no-details
 *   npm run scrape -- --since=7               only avis published in the last week
 *   npm run scrape -- --page-size=50          fewer, larger pages
 *   npm run scrape -- --source=exclusions     the official exclusion list
 *   npm run scrape -- --backfill              only the detail backlog
 *   npm run scrape -- --backfill --refresh-all  re-read every detail page
 *   npm run scrape -- --backfill --limit=500  a bounded sitting of it
 */
import { initDatabase } from '../src/db/init.js'
import { closeDb, getDb } from '../src/db/index.js'
import { createContainer } from '../src/container.js'
import { SOURCES } from '../src/scraper/runner.js'
import { assertConfigIsValid } from '../src/config/index.js'

function parseArgs(argv) {
  const options = { source: 'all', filters: {} }
  for (const arg of argv) {
    const [rawKey, rawValue = 'true'] = arg.replace(/^--/, '').split('=')
    if (rawKey.startsWith('filter.')) {
      options.filters[rawKey.slice('filter.'.length)] = rawValue
    } else if (rawKey === 'source') {
      options.source = rawValue
    } else if (rawKey === 'max-pages') {
      options.maxPages = Number.parseInt(rawValue, 10)
    } else if (rawKey === 'start-page') {
      options.startPage = Number.parseInt(rawValue, 10)
    } else if (rawKey === 'no-details') {
      options.fetchDetails = false
    } else if (rawKey === 'since') {
      options.sinceDays = Number.parseInt(rawValue, 10)
    } else if (rawKey === 'page-size') {
      options.pageSize = Number.parseInt(rawValue, 10)
    } else if (rawKey === 'backfill') {
      options.backfill = rawValue !== 'false'
    } else if (rawKey === 'refresh-all') {
      options.refreshAll = rawValue !== 'false'
    } else if (rawKey === 'limit') {
      options.limit = Number.parseInt(rawValue, 10)
    } else if (rawKey === 'details') {
      options.fetchDetails = rawValue !== 'false'
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
if (!SOURCES.includes(options.source)) {
  console.error(`--source must be one of ${SOURCES.join(', ')}`)
  process.exit(1)
}

assertConfigIsValid()
const db = await initDatabase(getDb())
const { runner } = createContainer(db)

try {
  const result = options.backfill
    ? await runner.backfillDetails({ limit: options.limit, refreshAll: options.refreshAll, triggeredBy: 'cli' })
    : await runner.run({ ...options, triggeredBy: 'cli' })
  console.log(JSON.stringify({ stats: result.stats, detail: result.detail }, null, 2))
} catch (error) {
  // "Another crawl is already running" is the guard doing its job, not a
  // failure. A scheduled run that steps aside should not colour the unit red
  // and page whoever is watching.
  if (error.statusCode === 409) {
    console.log(`Skipped: ${error.message}`)
  } else {
    console.error(`Scrape failed: ${error.message}`)
    process.exitCode = 1
  }
} finally {
  await closeDb()
}
