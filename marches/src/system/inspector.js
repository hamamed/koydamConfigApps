import os from 'node:os'
import { readFile, stat, statfs } from 'node:fs/promises'
import { config } from '../config/index.js'
import { SCHEMA_VERSION } from '../db/schema.js'
import { SEVERITY } from '../scraper/health.js'

/**
 * What the box looks like from inside the application, for the System screen.
 *
 * Two rules shape this module.
 *
 * It never shells out. The next run of the daily crawl is read from a setting
 * rather than from `systemctl` for the reason given in adminService, and the
 * same applies here: backups are read from the manifest the backup script
 * publishes for exactly this purpose, not from a process this application
 * spawns as root.
 *
 * And it never throws. A missing file, an unreadable directory or a manifest
 * written by a newer script all resolve to a check that says so. An operations
 * page that returns a 500 when something is wrong is blind precisely when it is
 * needed.
 */

/** Where backup.sh publishes its world-readable index. The archives beside it
 *  are root-only and hold every service's secrets; this is the only part the
 *  web application is allowed — or needs — to read. */
export const MANIFEST_PATH = '/var/backups/hamaprojects/inventory.json'

/** The manifest entry that proves this application's database was captured. */
const DATABASE_ENTRY = 'sqlite/marches'

/** Backups are nightly. One missed night is worth a warning, two a failure. */
const BACKUP_WARN_HOURS = 30
const BACKUP_FAIL_HOURS = 50

const DISK_WARN_PERCENT = 85
const DISK_FAIL_PERCENT = 94

export function createSystemInspector({
  settings,
  jobs,
  results,
  translation,
  mailer,
  manifestPath = MANIFEST_PATH,
  databaseFile = config.db.sqliteFile,
  storageDir = config.invoice.storageDir,
  appVersion = '',
  io = { readFile, stat, statfs },
  now = () => new Date(),
} = {}) {
  /**
   * @returns {Promise<object>} facts and checks. `severity` is the worst of the
   *   checks, so one value can drive the badge in the sidebar.
   */
  async function report() {
    const checks = []
    const add = (id, severity, detail) => checks.push({ id, severity, detail })

    const backup = await readBackup()
    describeBackup(backup, add)

    const disk = await readDisk()
    if (disk.error) add('disk', SEVERITY.WARN, disk.error)
    else {
      add(
        'disk',
        disk.usedPercent >= DISK_FAIL_PERCENT
          ? SEVERITY.FAIL
          : disk.usedPercent >= DISK_WARN_PERCENT
            ? SEVERITY.WARN
            : SEVERITY.OK,
        `${disk.usedPercent}% of the data volume used`,
      )
    }

    const database = await readDatabase()
    const storage = await readStorage()

    // Both of these are features that are built, wired and reaching nobody when
    // unconfigured — the failure mode this project keeps hitting — so they are
    // checks rather than facts.
    const mailReady = await safely(() => mailer?.isConfigured?.(), false)
    add('mail', mailReady ? SEVERITY.OK : SEVERITY.WARN,
      mailReady ? 'alerts are emailed' : 'alerts are recorded and logged, not emailed')

    const translationReady = await safely(() => translation?.isConfigured?.(), false)
    add('translation', translationReady ? SEVERITY.OK : SEVERITY.WARN,
      translationReady ? 'article translation is available' : 'no translation key: the buttons are disabled')

    const archive = await readArchive()
    // A stalled archive is silent: the daily crawl keeps the freshness check
    // green while the history stops growing. The only symptom is a page counter
    // that does not move, so it is a check rather than a statistic.
    if (archive) add('archive', ...describeArchive(archive))

    return {
      severity: worst(checks),
      checks,
      archive,
      backup,
      disk,
      database,
      storage,
      runtime: {
        appVersion,
        node: process.version,
        uptimeSeconds: Math.round(process.uptime()),
        rssBytes: process.memoryUsage().rss,
        heapUsedBytes: process.memoryUsage().heapUsed,
        startedAt: new Date(now().getTime() - process.uptime() * 1000).toISOString(),
      },
      /**
       * The machine, not the process.
       *
       * Six services share this box, so "how much memory is this one using" is
       * only half a question — the half that matters when something is being
       * killed is how much the host has left. Load is reported per core as
       * well as raw, because "load 4" means nothing until you know whether
       * that is four cores busy or four cores' worth of queue on one.
       */
      host: {
        platform: `${os.type()} ${os.release()}`,
        cpuModel: os.cpus()[0]?.model ?? null,
        cpuCount: os.cpus().length,
        loadAvg: os.loadavg().map((n) => Math.round(n * 100) / 100),
        loadPerCore: Math.round((os.loadavg()[0] / Math.max(1, os.cpus().length)) * 1000) / 10,
        totalMemBytes: os.totalmem(),
        freeMemBytes: os.freemem(),
        usedMemPercent: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100),
        uptimeSeconds: Math.round(os.uptime()),
      },
      schedule: {
        crawlAt: await safely(() => settings?.get('scraper.dailyRunAt'), null),
        alertsAt: await safely(() => settings?.get('alerts.dailyRunAt'), null),
      },
      integrations: { mail: mailReady, translation: translationReady },
    }
  }

  /**
   * How far the archival pass over the award history has got.
   *
   * `totalPages` is what the portal last told us it had, recorded by the
   * scraper rather than assumed here, so this reports the real denominator
   * instead of a number baked into the code.
   */
  async function readArchive() {
    const nextPage = Number(await safely(() => settings?.get('scraper.archiveNextPage'), 0)) || 0
    if (!nextPage) return null

    const recent = await safely(() => jobs?.listRecent(40), [])
    const last = (recent ?? []).find((job) => job.source === 'archive' && job.status === 'success') ?? null
    const totalPages = Number(safeParse(last?.detail_json)?.archive?.totalPages ?? 0) || null

    return {
      nextPage,
      totalPages,
      complete: totalPages !== null && nextPage > totalPages,
      percent: totalPages ? Math.min(100, Math.round(((nextPage - 1) / totalPages) * 100)) : null,
      lastSliceAt: last?.finished_at ?? null,
      // null, not Infinity: this is serialised to JSON and rendered, and
      // Infinity becomes null there anyway — after printing "Infinityh ago".
      stalledHours: last?.finished_at ? (now().getTime() - Date.parse(last.finished_at)) / 3_600_000 : null,
      running: (recent ?? []).some((job) => job.source === 'archive' && job.status === 'running'),
      awards: await safely(() => results?.countAll(), null),
    }
  }

  /** The backup manifest, or a shaped explanation of why there isn't one. */
  async function readBackup() {
    const empty = { path: manifestPath, generatedAt: null, archives: [], latest: null, ageHours: null,
      includesDatabase: false, error: null }
    try {
      const parsed = JSON.parse(await io.readFile(manifestPath, 'utf8'))
      const archives = Array.isArray(parsed.archives) ? parsed.archives : []
      const latest = archives[0] ?? null
      const contents = Array.isArray(parsed.contents) ? parsed.contents.map((row) => row.name) : []
      return {
        ...empty,
        generatedAt: parsed.generatedAt ?? null,
        archives: archives.slice(0, 7),
        latest,
        ageHours: latest?.at ? hoursSince(latest.at) : null,
        includesDatabase: contents.includes(DATABASE_ENTRY),
      }
    } catch (error) {
      // ENOENT on a box that has never run a backup, EACCES if the directory
      // permissions changed. Both are worth reading, and neither is a crash.
      return { ...empty, error: error.code === 'ENOENT' ? 'no backup manifest on this host' : error.message }
    }
  }

  function describeBackup(backup, add) {
    if (backup.error || !backup.latest) {
      add('backup', SEVERITY.FAIL, backup.error ?? 'no backup has been written')
      return
    }
    add(
      'backup',
      backup.ageHours > BACKUP_FAIL_HOURS
        ? SEVERITY.FAIL
        : backup.ageHours > BACKUP_WARN_HOURS
          ? SEVERITY.WARN
          : SEVERITY.OK,
      `last backup ${Math.round(backup.ageHours)}h ago`,
    )
    // An archive that exists but does not contain this database is the failure
    // this check was written for: bdc was absent from the backup script for the
    // whole of its first month, and every nightly archive looked healthy.
    add(
      'backupCoverage',
      backup.includesDatabase ? SEVERITY.OK : SEVERITY.FAIL,
      backup.includesDatabase ? 'the database is in the archive' : 'the archive does not contain this database',
    )
  }

  async function readDisk() {
    try {
      const fs = await io.statfs(directoryOf(databaseFile))
      const total = fs.blocks * fs.bsize
      const free = fs.bavail * fs.bsize
      if (!total) return { error: 'the data volume reports no size' }
      return {
        totalBytes: total,
        freeBytes: free,
        usedBytes: total - free,
        usedPercent: Math.round(((total - free) / total) * 100),
      }
    } catch (error) {
      return { error: error.message }
    }
  }

  async function readDatabase() {
    const shape = { dialect: config.db.client, file: databaseFile, sizeBytes: null, schemaVersion: SCHEMA_VERSION }
    if (config.db.client !== 'sqlite' || databaseFile === ':memory:') return shape
    try {
      return { ...shape, sizeBytes: (await io.stat(databaseFile)).size }
    } catch {
      return shape
    }
  }

  async function readStorage() {
    try {
      return { dir: storageDir, exists: (await io.stat(storageDir)).isDirectory() }
    } catch {
      return { dir: storageDir, exists: false }
    }
  }

  const hoursSince = (iso) => {
    const at = Date.parse(iso)
    return Number.isNaN(at) ? null : (now().getTime() - at) / 3_600_000
  }

  return { report }
}

/**
 * How the archival pass is doing, in words.
 *
 * A slice running right now is the healthy case and must not read as stalled;
 * and until the first slice finishes, the portal has not told us how many pages
 * there are, so the denominator is left out rather than printed as "null".
 */
function describeArchive(archive) {
  const at = archive.totalPages ? `page ${archive.nextPage} of ${archive.totalPages}` : `page ${archive.nextPage}`
  if (archive.complete) return [SEVERITY.OK, 'the award history is complete']
  if (archive.running) return [SEVERITY.OK, `${at}, a slice is running`]
  if (archive.stalledHours === null) return [SEVERITY.OK, `${at}, no slice has finished yet`]
  const hours = Math.round(archive.stalledHours)
  return [archive.stalledHours > STALE_SLICE_HOURS ? SEVERITY.WARN : SEVERITY.OK, `${at}, last slice ${hours}h ago`]
}

/** Slices run hourly, so a gap this long means the pass has stopped. */
const STALE_SLICE_HOURS = 6

const RANK = { [SEVERITY.OK]: 0, [SEVERITY.WARN]: 1, [SEVERITY.FAIL]: 2 }

/** The worst severity present, so one badge can stand for the whole page. */
export function worst(checks) {
  return checks.reduce((acc, check) => (RANK[check.severity] > RANK[acc] ? check.severity : acc), SEVERITY.OK)
}

const directoryOf = (file) => (file && file !== ':memory:' ? file.replace(/\/[^/]*$/, '') || '/' : '.')

async function safely(fn, fallback) {
  try {
    const value = await fn()
    return value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

const safeParse = (value) => {
  try {
    return JSON.parse(value ?? '')
  } catch {
    return null
  }
}
