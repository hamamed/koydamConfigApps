import { Router } from 'express'
import { consultationRoutes } from './consultations.js'
import { resultRoutes } from './results.js'
import { favoriteRoutes } from './favorites.js'
import { invoiceRoutes } from './invoices.js'
import { authRoutes } from './auth.js'
import { adminRoutes } from './admin.js'
import { ok } from '../../utils/pagination.js'

export function registerRoutes(app, container) {
  app.get('/health', (_req, res) => res.json(ok({ status: 'ok', uptime: process.uptime() })))

  app.use('/api/auth', authRoutes(container))
  app.use('/api/consultations', consultationRoutes(container))
  app.use('/api/results', resultRoutes(container))
  app.use('/api/favorites', favoriteRoutes(container))
  app.use('/api/invoices', invoiceRoutes(container))
  app.use('/admin', adminRoutes(container))

  return app
}
