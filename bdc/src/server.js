import { config, assertConfigIsValid } from './config/index.js'
import { createApp } from './app.js'
import { initDatabase } from './db/init.js'
import { closeDb, getDb } from './db/index.js'
import { logger } from './utils/logger.js'

const log = logger.child('[server]')
const SHUTDOWN_TIMEOUT_MS = 10_000

async function main() {
  assertConfigIsValid()
  await initDatabase(getDb())

  const app = createApp()
  const server = app.listen(config.server.port, config.server.host, () => {
    log.info('listening', {
      host: config.server.host,
      port: config.server.port,
      env: config.env,
      db: config.db.client,
    })
  })

  const shutdown = async (signal) => {
    log.info('shutting down', { signal })
    const timer = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref()
    server.close(async () => {
      await closeDb()
      clearTimeout(timer)
      process.exit(0)
    })
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('unhandledRejection', (reason) => log.error('unhandled rejection', { reason: String(reason) }))
}

main().catch((error) => {
  log.error('failed to start', { message: error.message, stack: error.stack })
  process.exit(1)
})
