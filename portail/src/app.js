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

/**
 * The distinct origins of the services in config, for the CSP. Read from the
 * same list the chooser links to, so adding a service does not need a second
 * edit here that somebody would find out about through a blocked redirect.
 */
function serviceOrigins() {
  const origins = new Set()
  for (const service of config.services) {
    try {
      origins.add(new URL(service.url).origin)
    } catch {
      // A malformed URL in config is the config's problem, not the CSP's.
    }
  }
  return [...origins]
}

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
          /**
           * The services this portal signs people in to, not just this origin.
           *
           * `form-action` is enforced across redirects: the sign-in form posts
           * here, the response is a 302 to bdc or marches, and with `'self'`
           * alone the browser cancels that navigation — after the session
           * cookie has already been set. The symptom is a login that appears
           * to do nothing until you go back, and find yourself signed in.
           *
           * (It governs form submissions only. The chooser's links out are
           * <a> elements and were never affected — the comment that used to
           * sit here said otherwise and set 'self' anyway.)
           */
          formAction: ["'self'", ...serviceOrigins()],
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
