import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSystemInspector } from '../src/system/inspector.js'
import { createMailer } from '../src/notifications/mailer.js'

/** A manifest in the shape backup.sh writes, aged by `hours`. */
async function manifest({ hours = 2, contents = ['sqlite/bdc', 'postgres/brawl'] } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'bdc-system-'))
  const file = path.join(dir, 'inventory.json')
  const at = new Date(Date.now() - hours * 3_600_000).toISOString()
  await writeFile(file, JSON.stringify({
    generatedAt: at,
    archives: [{ name: `hamaprojects-${hours}.tar.gz`, sizeBytes: 921332928, at }],
    contents: contents.map((name) => ({ name, files: 1 })),
  }))
  return file
}

const inspector = (options) => createSystemInspector({ appVersion: '9.9.9', ...options })
const check = (report, id) => report.checks.find((entry) => entry.id === id)

test('the system screen reads the backup manifest rather than the archives', async () => {
  const report = await inspector({ manifestPath: await manifest({ hours: 3 }) }).report()

  assert.equal(check(report, 'backup').severity, 'ok')
  assert.match(check(report, 'backup').detail, /3h ago/)
  assert.equal(report.backup.latest.sizeBytes, 921332928)
  assert.equal(report.backup.includesDatabase, true)
})

test('an archive that does not contain this database is a failure, not a pass', async () => {
  // The bug this check exists for: bdc was absent from backup.sh for its whole
  // first month and every nightly archive still looked perfectly healthy.
  const report = await inspector({
    manifestPath: await manifest({ contents: ['postgres/brawl', 'sqlite/minebox'] }),
  }).report()

  assert.equal(check(report, 'backup').severity, 'ok', 'a backup did run')
  assert.equal(check(report, 'backupCoverage').severity, 'fail', 'but not of this database')
  assert.equal(report.severity, 'fail', 'and the page says so at the top')
})

test('a backup that stopped running is reported, and an absent one does not crash', async () => {
  const stale = await inspector({ manifestPath: await manifest({ hours: 40 }) }).report()
  assert.equal(check(stale, 'backup').severity, 'warn')

  const dead = await inspector({ manifestPath: await manifest({ hours: 100 }) }).report()
  assert.equal(check(dead, 'backup').severity, 'fail')

  const missing = await inspector({ manifestPath: '/nonexistent/inventory.json' }).report()
  assert.equal(check(missing, 'backup').severity, 'fail')
  assert.match(missing.backup.error, /no backup manifest/)
  assert.ok(missing.disk, 'the rest of the page is still reported')
})

test('an unconfigured integration reads as unconfigured', async () => {
  // `Boolean(somethingAsync())` is true for every promise, so an async
  // isConfigured() checked without awaiting reports every integration as ready.
  const report = await inspector({
    manifestPath: await manifest(),
    mailer: createMailer({ resolve: async () => ({ host: '' }) }),
    translation: { isConfigured: async () => false },
  }).report()

  assert.equal(report.integrations.mail, false)
  assert.equal(report.integrations.translation, false)
  assert.equal(check(report, 'mail').severity, 'warn')
  assert.match(check(report, 'mail').detail, /not emailed/)
})

test('an SMTP server entered in the panel is used on the next send, not the next restart', async () => {
  let host = ''
  const mailer = createMailer({ resolve: async () => ({ host, port: 2525, from: 'bdc@civictrust.ma' }) })

  assert.equal(await mailer.isConfigured(), false)
  const logged = await mailer.send({ to: 'a@b.ma', subject: 'x', text: 'y' })
  assert.equal(logged.channel, 'log', 'with no server the pipeline still completes end to end')

  host = 'smtp.example.ma'
  assert.equal(await mailer.isConfigured(), true, 'the panel value takes effect without a rebuild')

  // A settings read that throws must not stop an alert from being recorded:
  // losing the notification would be worse than sending it to the log.
  const broken = createMailer({ resolve: async () => { throw new Error('database is locked') } })
  assert.equal(await broken.isConfigured(), false)
  assert.equal((await broken.send({ to: 'a@b.ma', subject: 'x', text: 'y' })).channel, 'log')
})
