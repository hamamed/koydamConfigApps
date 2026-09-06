import { Router } from 'express'
import { consultationRoutes } from './consultations.js'
import { resultRoutes } from './results.js'
import { favoriteRoutes } from './favorites.js'
import { invoiceRoutes } from './invoices.js'
import { authRoutes } from './auth.js'
import { adminRoutes } from './admin.js'
import { ok } from '../../utils/pagination.js'
import { dictionaryFor, LOCALES } from '../../i18n/index.js'

export function registerRoutes(app, container) {
  app.get('/health', (_req, res) => res.json(ok({ status: 'ok', uptime: process.uptime() })))

  /**
   * UI strings for the resolved locale, so a client that renders its own
   * interface does not have to duplicate the dictionary.
   */
  app.get('/api/i18n', (req, res) =>
    res.json(ok({ locale: req.locale, locales: LOCALES, strings: dictionaryFor(req.locale) })),
  )

  app.use('/api/auth', authRoutes(container))
  app.use('/api/consultations', consultationRoutes(container))
  app.use('/api/results', resultRoutes(container))
  app.use('/api/favorites', favoriteRoutes(container))
  app.use('/api/invoices', invoiceRoutes(container))
  app.use('/admin', adminRoutes(container))

  return app
}
