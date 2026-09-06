#!/usr/bin/env node
/**
 * Runs the alert pass: saved searches, then deadline reminders, then delivery.
 *
 *   node bin/alerts.js
 *
 * Safe to run repeatedly. Each saved search remembers where it got to, so a
 * second run in the same hour sends nothing new.
 */
import { initDatabase } from '../src/db/init.js'
import { closeDb, getDb } from '../src/db/index.js'
import { createContainer } from '../src/container.js'
import { assertConfigIsValid, config } from '../src/config/index.js'

assertConfigIsValid()
const db = await initDatabase(getDb())
const { services } = createContainer(db)

if (!config.mail.enabled) {
  console.log('SMTP is not configured — alerts will be recorded and logged, not emailed.')
}

try {
  console.log(JSON.stringify(await services.alerts.run(), null, 2))
} catch (error) {
  console.error(`Alert run failed: ${error.message}`)
  process.exitCode = 1
} finally {
  await closeDb()
}
