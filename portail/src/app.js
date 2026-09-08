import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import morgan from 'morgan'
import { config } from './config/index.js'
import { registerRoutes } from './http/routes.js'
import { logger } from './utils/logger.js'

const VIEWS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'views')

export function createApp(container) {
  const app = express()

  app.set('view engine', 'ejs')
  app.set('views', VIEWS_DIR)
  // Behind nginx. Without this the rate limiter buckets every request under the
  // proxy's own address and the sign-in log records it as everyone's IP.
  app.set('trust proxy', 1)

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          // The chooser links out to the services this portal fronts, and a
          // browser must be allowed to follow those.
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      // The services are on sibling subdomains; a strict same-origin policy
      // would stop the browser sending the shared cookie when following a link.
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    }),
  )

  app.use(cookieParser())
  app.use(express.urlencoded({ extended: true }))
  app.use(express.json({ limit: '64kb' }))
  if (!config.isProduction || config.logLevel === 'debug') app.use(morgan('tiny'))

  registerRoutes(app, container)

  app.use((req, res) => res.status(404).render('error', { status: 404, message: 'Page introuvable', config }))

  app.use((error, _req, res, _next) => {
    const status = error.statusCode ?? 500
    if (status >= 500) logger.child('[http]').error('unhandled', { message: error.message, stack: error.stack })
    res.status(status).render('error', {
      status,
      message: status >= 500 ? 'Une erreur est survenue' : error.message,
      config,
    })
  })

  return app
}
