#!/usr/bin/env node
/**
 * Loads a BTP register export into the database.
 *
 *   node bin/import-btp.js btp.json
 *
 * The counterpart to bin/export-btp.js. Idempotent: the same upsert the scraper
 * uses, so importing twice changes nothing.
 */
import { readFile } from 'node:fs/promises'
import { getDb } from '../src/db/index.js'
import { initDatabase } from '../src/db/init.js'
import { createBtpRepository } from '../src/repositories/btpRepository.js'
import { logger } from '../src/utils/logger.js'

const log = logger.child('[import:btp]')
const [source] = process.argv.slice(2)
if (!source) {
  console.error('Usage: node bin/import-btp.js <export.json>')
  process.exit(1)
}

const payload = JSON.parse(await readFile(source, 'utf8'))
const companies = payload.companies ?? []
if (companies.length === 0) {
  console.error(`${source} contains no companies`)
  process.exit(1)
}

await initDatabase(getDb())
const btp = createBtpRepository()
const stats = { created: 0, updated: 0, unchanged: 0, failed: 0 }

for (const record of companies) {
  try {
    const { outcome } = await btp.upsert(record)
    stats[outcome] += 1
  } catch (error) {
    stats.failed += 1
    log.error('upsert failed', { raisonSociale: record.raison_sociale, message: error.message })
  }
}

log.info('imported', { source, exportedAt: payload.exportedAt, ...stats, held: await btp.countAll() })
