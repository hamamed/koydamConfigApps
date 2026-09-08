import { config, assertConfigIsValid } from './config/index.js'
import { createContainer } from './container.js'
import { createApp } from './app.js'
import { logger } from './utils/logger.js'

const log = logger.child('[server]')

assertConfigIsValid()

const server = createApp(createContainer()).listen(config.port, () => {
  log.info('listening', { port: config.port, env: config.env, url: config.publicUrl })
})

const shutdown = (signal) => {
  log.info('shutting down', { signal })
  server.close(() => process.exit(0))
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
