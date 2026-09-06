import { Router } from 'express'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { requireAdmin } from '../middleware/auth.js'
import { parseFilters } from '../filters.js'
import { ok, paginated, parsePagination } from '../../utils/pagination.js'

/**
 * The administrative JSON API under `/admin/api`, called by the panel's own
 * buttons. The screens themselves live in routes/panel.js.
 */
export function adminRoutes({ services }) {
  const router = Router()

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

  api.get('/users', asyncHandler(async (_req, res) => res.json(ok(await services.users.list()))))

  api.post(
    '/users',
    asyncHandler(async (req, res) => res.status(201).json(ok(await services.users.create(req.body)))),
  )

  api.patch(
    '/users/:id/role',
    asyncHandler(async (req, res) =>
      res.json(ok(await services.users.setRole(Number(req.params.id), req.body.role, req.user.id))),
    ),
  )

  api.patch(
    '/users/:id/active',
    asyncHandler(async (req, res) =>
      res.json(ok(await services.users.setActive(Number(req.params.id), req.body.isActive === true, req.user.id))),
    ),
  )

  api.post(
    '/users/:id/password',
    asyncHandler(async (req, res) =>
      res.json(ok(await services.users.resetPassword(Number(req.params.id), req.body.password))),
    ),
  )

  api.delete(
    '/users/:id',
    asyncHandler(async (req, res) => res.json(ok(await services.users.remove(Number(req.params.id), req.user.id)))),
  )

  api.get('/settings', asyncHandler(async (_req, res) => res.json(ok(await services.settings.describe()))))

  api.patch(
    '/settings',
    asyncHandler(async (req, res) => res.json(ok(await services.settings.update(req.body, req.user.id)))),
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
