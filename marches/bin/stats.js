#!/usr/bin/env node
/**
 * Row counts and freshness for the scraped tables. Useful for checking on a
 * crawl in progress, and for a quick answer to "did the last run do anything".
 *
 *   sudo -u brawl node bin/stats.js
 */
import { getDb, closeDb } from '../src/db/index.js'
import { createContainer } from '../src/container.js'

const db = getDb()
const { repositories } = createContainer(db)
const scalar = async (sql) => Object.values((await db.get(sql)) ?? {})[0]

const [consultations, articles, results, unmatched, jobs] = await Promise.all([
  repositories.consultations.countAll(),
  repositories.articles.countAll(),
  repositories.results.countAll(),
  repositories.results.countUnmatched(),
  repositories.jobs.listRecent(3),
])

console.log(`consultations   ${consultations}`)
console.log(`articles        ${articles}`)
console.log(`results         ${results}  (${results - unmatched} matched, ${unmatched} unmatched)`)
console.log(`awarded         ${await scalar("SELECT COUNT(*) FROM consultations WHERE has_result = 1")}`)
console.log(`cancelled       ${await scalar("SELECT COUNT(*) FROM consultations WHERE status = 'annule'")}`)
console.log(`newest deadline ${await scalar('SELECT MAX(date_limite) FROM consultations')}`)
console.log('\nrecent jobs')
for (const job of jobs) {
  const seconds = job.duration_ms === null ? '—' : `${Math.round(job.duration_ms / 1000)}s`
  console.log(
    `  #${job.id} ${job.source.padEnd(14)} ${job.status.padEnd(8)} ` +
      `pages=${job.pages_scraped} found=${job.items_found} new=${job.items_created} ` +
      `linked=${job.matches_linked} ${seconds}${job.error_message ? ` — ${job.error_message}` : ''}`,
  )
}

await closeDb()
