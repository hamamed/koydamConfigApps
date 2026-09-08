import { config, assertConfigIsValid } from './config/index.js'
import { initDatabase } from './db/init.js'
import { getDb, closeDb } from './db/index.js'
import { createContainer } from './container.js'
import { createApp } from './app.js'
import { logger } from './utils/logger.js'

const log = logger.child('[server]')

assertConfigIsValid()

const db = getDb()
await initDatabase(db)

const server = createApp(createContainer(db)).listen(config.port, () => {
  log.info('listening', { port: config.port, env: config.env, url: config.publicUrl })
})

/** Finish in-flight requests before the process goes, so a deploy drops nothing. */
const shutdown = async (signal) => {
  log.info('shutting down', { signal })
  server.close(async () => {
    await closeDb()
    process.exit(0)
  })
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
