#!/usr/bin/env node
/**
 * Drops and recreates the scraped tables, keeping accounts and job history.
 *
 *   node bin/rebuild-scraped.js            # dry run: says what it would do
 *   node bin/rebuild-scraped.js --yes      # do it
 *
 * Why this exists rather than a migration: the 2026-09-06.005 schema moved
 * identity off `reference` and onto the portal's id. Rows written before it
 * cannot be remapped, because `UNIQUE(reference)` had already merged avis from
 * different buyers that share a reference — there is no way to tell afterwards
 * which buyer a merged row belonged to. The data is a public portal's, so
 * re-crawling is both cheaper and more truthful than inventing a mapping.
 *
 * Refuses to run if anyone has saved favourites or invoices; those are the only
 * rows here that a person created and that a crawl cannot reproduce.
 */
import { getDb, closeDb } from '../src/db/index.js'
import { initDatabase } from '../src/db/init.js'
import { config } from '../src/config/index.js'

// Children first — the foreign keys point upward.
const SCRAPED_TABLES = [
  'invoice_items',
  'invoices',
  'favorites',
  'result_lots',
  'consultation_results',
  'consultation_articles',
  'consultations',
]
const PRESERVED = ['users', 'scrape_jobs']

const confirmed = process.argv.includes('--yes')
const forced = process.argv.includes('--force')
const db = getDb()

const countOf = async (table) => {
  try {
    return Number((await db.get(`SELECT COUNT(*) AS c FROM ${table}`)).c)
  } catch {
    return null // table does not exist yet
  }
}

console.log(`database: ${config.db.client === 'sqlite' ? config.db.sqliteFile : 'postgres'}\n`)
console.log('will drop and recreate:')
for (const table of SCRAPED_TABLES) console.log(`  ${table.padEnd(24)} ${await countOf(table) ?? '(absent)'} rows`)
console.log('\nwill keep:')
for (const table of PRESERVED) console.log(`  ${table.padEnd(24)} ${await countOf(table) ?? '(absent)'} rows`)

const handmade = (await countOf('favorites')) ?? 0
const invoiced = (await countOf('invoices')) ?? 0
if ((handmade > 0 || invoiced > 0) && !forced) {
  console.error(
    `\nRefusing: ${handmade} favourite(s) and ${invoiced} invoice(s) exist, and a crawl cannot recreate them.` +
      '\nExport them first, then re-run with --force.',
  )
  await closeDb()
  process.exit(1)
}

if (!confirmed) {
  console.log('\nDry run. Re-run with --yes to apply.')
  await closeDb()
  process.exit(0)
}

for (const table of SCRAPED_TABLES) {
  await db.exec(`DROP TABLE IF EXISTS ${table}`)
  console.log(`dropped ${table}`)
}
await db.run('DELETE FROM schema_migrations')

await initDatabase(db)
console.log('\nSchema rebuilt. Re-populate with:')
console.log('  node bin/scrape.js --source=all --max-pages=25')
console.log('  node bin/scrape.js --backfill')

await closeDb()
