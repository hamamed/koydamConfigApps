import path from 'node:path'
import express from 'express'
import helmet from 'helmet'
import morgan from 'morgan'
import cookieParser from 'cookie-parser'
import { config } from './config/index.js'
import { createContainer } from './container.js'
import { registerRoutes } from './http/routes/index.js'
import { errorHandler, notFoundHandler } from './http/middleware/errorHandler.js'
import { createApiLimiter } from './http/middleware/rateLimit.js'
import { localeMiddleware } from './http/middleware/locale.js'

const JSON_BODY_LIMIT = '1mb'
/** Room for a base64 logo on the one form that carries one. */
const LOGO_FORM_LIMIT = '1mb'

/**
 * Builds the Express application.
 * @param {object} [container] injected composition root — tests pass one built
 *   over an in-memory database.
 */
export function createApp(container = createContainer()) {
  const app = express()

  app.set('trust proxy', 1)
  app.set('view engine', 'ejs')
  app.set('views', path.join(config.rootDir, 'src', 'views'))

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
        },
      },
    }),
  )
  app.use(cors())
  app.use(express.json({ limit: JSON_BODY_LIMIT }))
  // A logo arrives base64 inside a normal form field, which is larger than any
  // other form on this panel has any business being. The global parser below
  // runs first and would reject it before the route could raise its own limit,
  // so that one path is parsed here and everything else stays capped.
  app.use('/panel/invoices/apparence', express.urlencoded({ extended: true, limit: LOGO_FORM_LIMIT }))
  app.use(express.urlencoded({ extended: true }))
  app.use(cookieParser())
  app.use(localeMiddleware(container.settings))
  if (!config.isTest) app.use(morgan(config.isProduction ? 'combined' : 'dev'))

  app.use('/api', createApiLimiter())

  registerRoutes(app, container)

  app.use(notFoundHandler)
  app.use(errorHandler)

  app.locals.container = container
  return app
}

/** Minimal CORS handling driven by CORS_ORIGINS; avoids an extra dependency. */
function cors() {
  const allowed = new Set(config.server.corsOrigins)
  const allowAll = allowed.has('*')

  return (req, res, next) => {
    const origin = req.headers.origin
    if (origin && (allowAll || allowed.has(origin))) {
      res.setHeader('Access-Control-Allow-Origin', allowAll ? '*' : origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Credentials', 'true')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  }
}
