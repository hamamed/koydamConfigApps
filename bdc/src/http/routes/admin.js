import { Router } from 'express'
import { config } from '../../config/index.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { requireAdmin, requireAdminPage } from '../middleware/auth.js'
import { cookieOptions, createLoginLimiter } from '../middleware/rateLimit.js'
import { parseFilters } from '../filters.js'
import { ok, paginated, parsePagination } from '../../utils/pagination.js'

/**
 * Admin panel: server-rendered pages under `/admin` plus a JSON API under
 * `/admin/api` used by the dashboard's own fetch calls.
 */
export function adminRoutes({ services }) {
  const router = Router()
  const loginLimiter = createLoginLimiter()

  // -------------------------------------------------------------- HTML pages
  router.get('/login', (req, res) => {
    res.render('admin/login', { error: null, next: req.query.next ?? '/admin', email: '' })
  })

  router.post(
    '/login',
    loginLimiter,
    asyncHandler(async (req, res) => {
      const target = safeRedirect(req.body.next)
      try {
        const { token, user } = await services.auth.login(req.body.email, req.body.password)
        if (user.role !== 'admin') {
          return res.status(403).render('admin/login', {
            error: 'This account is not an administrator.',
            next: target,
            email: req.body.email ?? '',
          })
        }
        res.cookie(config.auth.cookieName, token, cookieOptions)
        res.redirect(target)
      } catch (error) {
        res.status(401).render('admin/login', { error: error.message, next: target, email: req.body.email ?? '' })
      }
    }),
  )

  router.post('/logout', (req, res) => {
    res.clearCookie(config.auth.cookieName, { ...cookieOptions, maxAge: undefined })
    res.redirect('/admin/login')
  })

  router.get(
    '/',
    requireAdminPage(services.auth),
    asyncHandler(async (req, res) => {
      res.render('admin/dashboard', { user: req.user, dashboard: await services.admin.dashboard() })
    }),
  )

  router.get(
    '/consultations',
    requireAdminPage(services.auth),
    asyncHandler(async (req, res) => {
      const filters = parseFilters(req.query)
      const pagination = parsePagination(req.query)
      const { data, total } = await services.consultations.search(filters, { ...pagination, sort: req.query.sort })
      res.render('admin/consultations', {
        user: req.user,
        rows: data,
        total,
        pagination,
        query: req.query,
      })
    }),
  )

  // --------------------------------------------------------------- JSON API
  const api = Router()
  api.use(requireAdmin(services.auth))

  api.get('/dashboard', asyncHandler(async (_req, res) => res.json(ok(await services.admin.dashboard()))))

  api.get('/jobs', asyncHandler(async (req, res) => res.json(ok(await services.admin.listJobs(Number(req.query.limit) || 20)))))

  /** Manually triggers a scrape; returns 202 unless `wait=true` is requested. */
  api.post(
    '/scrape',
    asyncHandler(async (req, res) => {
      const result = await services.admin.triggerScrape(
        {
          source: req.body.source,
          filters: req.body.filters,
          maxPages: req.body.maxPages,
          fetchDetails: req.body.fetchDetails,
          wait: req.body.wait === true,
        },
        req.user.email,
      )
      res.status(req.body.wait === true ? 200 : 202).json(ok(result))
    }),
  )

  api.post('/rematch', asyncHandler(async (_req, res) => res.json(ok(await services.admin.rematch()))))

  /** Reads the detail page of every consultation that has never had one read. */
  api.post(
    '/backfill-details',
    asyncHandler(async (req, res) => {
      const result = await services.admin.backfillDetails(
        { limit: req.body.limit, wait: req.body.wait === true },
        req.user.email,
      )
      res.status(req.body.wait === true ? 200 : 202).json(ok(result))
    }),
  )

  api.get(
    '/consultations',
    asyncHandler(async (req, res) => {
      const pagination = parsePagination(req.query)
      const { data, total } = await services.consultations.search(parseFilters(req.query), {
        ...pagination,
        sort: req.query.sort,
      })
      res.json(paginated(data, total, pagination))
    }),
  )

  api.patch(
    '/consultations/:id',
    asyncHandler(async (req, res) => res.json(ok(await services.admin.updateConsultation(Number(req.params.id), req.body)))),
  )

  api.delete(
    '/consultations/:id',
    asyncHandler(async (req, res) => res.json(ok(await services.admin.deleteConsultation(Number(req.params.id))))),
  )

  api.post(
    '/consultations/:id/refresh',
    asyncHandler(async (req, res) => res.json(ok(await services.admin.refreshConsultationDetail(Number(req.params.id))))),
  )

  api.patch(
    '/results/:id',
    asyncHandler(async (req, res) => res.json(ok(await services.admin.updateResult(Number(req.params.id), req.body)))),
  )

  api.delete(
    '/results/:id',
    asyncHandler(async (req, res) => res.json(ok(await services.admin.deleteResult(Number(req.params.id))))),
  )

  router.use('/api', api)
  return router
}

/** Prevents open redirects through the `next` parameter. */
const safeRedirect = (value) => (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/admin')
