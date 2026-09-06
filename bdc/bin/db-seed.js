#!/usr/bin/env node
import crypto from 'node:crypto'
import { initDatabase } from '../src/db/init.js'
import { closeDb, getDb } from '../src/db/index.js'
import { createContainer } from '../src/container.js'
import { config, assertConfigIsValid } from '../src/config/index.js'

const GENERATED_PASSWORD_BYTES = 12

assertConfigIsValid()
const db = await initDatabase(getDb())
const { services, repositories } = createContainer(db)

const email = config.auth.adminEmail
const existing = await repositories.users.findByEmailWithSecret(email)

if (existing) {
  console.log(`Admin ${email} already exists (id ${existing.id}) — nothing to do.`)
} else {
  const password = config.auth.adminPassword || crypto.randomBytes(GENERATED_PASSWORD_BYTES).toString('base64url')
  await services.auth.register({ email, password, fullName: 'Administrator', role: 'admin' })
  console.log(`Created admin ${email}`)
  if (!config.auth.adminPassword) {
    console.log(`Generated password (store it now, it is not recoverable): ${password}`)
  }
}

await closeDb()
