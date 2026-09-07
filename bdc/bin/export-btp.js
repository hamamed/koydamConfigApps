#!/usr/bin/env node
/**
 * Crawls the BTP qualification register and writes it to a JSON file.
 *
 *   node bin/export-btp.js btp.json [--pages=600] [--delay=1500]
 *
 * This exists because the ministry's site filters the server: from the VPS a
 * TCP connection to equipement.gov.ma never completes, while from an ordinary
 * connection it answers in milliseconds — the same block OMPIC applies. The
 * register changes on the scale of years, so exporting it from a machine that
 * can reach the site and importing it with bin/import-btp.js is a reasonable
 * answer, and the scraper itself stays exactly the code the server would run if
 * that block were ever lifted or a proxy put in front of it.
 */
import { writeFile } from 'node:fs/promises'
import { createHttpClient } from '../src/scraper/httpClient.js'
import { createBtpScraper } from '../src/scraper/btpScraper.js'
import { logger } from '../src/utils/logger.js'

const log = logger.child('[export:btp]')
const [target = 'btp.json', ...rest] = process.argv.slice(2)
const flag = (name, fallback) => {
  const found = rest.find((arg) => arg.startsWith(`--${name}=`))
  return found ? Number.parseInt(found.split('=')[1], 10) : fallback
}

const collected = []
/** Stands in for the repository: the scraper stores, this one remembers. */
const collector = {
  upsert: async (record) => {
    collected.push(record)
    return { outcome: 'created' }
  },
}

const http = createHttpClient({ delayMs: flag('delay', 1500), timeoutMs: 45_000 })
const scraper = createBtpScraper({ http, btp: collector })

const stats = await scraper.scrape({ startPage: 1, pages: flag('pages', 600) })
await writeFile(target, JSON.stringify({ exportedAt: new Date().toISOString(), ...stats, companies: collected }, null, 1))
log.info('written', { target, companies: collected.length, total: stats.total, pages: stats.pagesScraped })
