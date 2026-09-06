#!/usr/bin/env node
import { initDatabase } from '../src/db/init.js'
import { closeDb, getDb } from '../src/db/index.js'
import { config, assertConfigIsValid } from '../src/config/index.js'

assertConfigIsValid()
await initDatabase(getDb())
console.log(`Schema ready on ${config.db.client}.`)
await closeDb()
