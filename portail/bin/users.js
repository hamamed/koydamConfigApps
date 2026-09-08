#!/usr/bin/env node
/**
 * Account management for the shared sign-in.
 *
 *   node bin/users.js list
 *   node bin/users.js add you@example.ma 'a long password' --name='Full Name' --role=admin
 *   node bin/users.js password you@example.ma 'a new long password'
 *   node bin/users.js services you@example.ma bdc,marches
 *
 * This is the only place a password is set for any CivicTrust service now, so
 * it lives in the portal rather than being duplicated in each of them.
 */
import { initDatabase } from '../src/db/init.js'
import { closeDb, getDb } from '../src/db/index.js'
import { createContainer } from '../src/container.js'
import { assertConfigIsValid } from '../src/config/index.js'

assertConfigIsValid()
const db = getDb()
await initDatabase(db)
const { services, repositories } = createContainer(db)

const [command, ...rest] = process.argv.slice(2)
const flags = Object.fromEntries(
  rest.filter((a) => a.startsWith('--')).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=')
    return [k, v.join('=') || 'true']
  }),
)
const args = rest.filter((a) => !a.startsWith('--'))

try {
  if (command === 'list') {
    const rows = await repositories.users.listAll()
    if (rows.length === 0) console.log('No accounts yet.')
    for (const u of rows) {
      console.log(`${String(u.id).padStart(3)}  ${u.email.padEnd(34)} ${u.role.padEnd(6)} ${u.services.padEnd(14)} ${u.is_active ? '' : '(inactive)'}`)
    }
  } else if (command === 'add') {
    const [email, password] = args
    if (!email || !password) throw new Error('usage: add <email> <password> [--name=] [--role=] [--services=]')
    const user = await services.auth.register({
      email,
      password,
      fullName: flags.name ?? null,
      role: flags.role ?? 'user',
      services: flags.services ?? 'bdc,marches',
    })
    console.log(`Created ${user.email} (${user.role}) with access to ${user.services.join(', ')}`)
  } else if (command === 'password') {
    const [email, password] = args
    const user = await repositories.users.findByEmail(String(email ?? '').toLowerCase())
    if (!user) throw new Error(`No account for ${email}`)
    await services.auth.setPassword(user.id, password)
    console.log(`Password updated for ${user.email}`)
  } else if (command === 'services') {
    const [email, list] = args
    const user = await repositories.users.findByEmail(String(email ?? '').toLowerCase())
    if (!user) throw new Error(`No account for ${email}`)
    await repositories.users.update(user.id, { services: list })
    console.log(`${user.email} may now open: ${list}`)
  } else {
    console.log('Commands: list | add | password | services')
    process.exitCode = 1
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  await closeDb()
}
