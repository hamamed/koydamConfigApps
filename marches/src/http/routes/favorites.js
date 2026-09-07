import { Router } from 'express'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { requireAuth } from '../middleware/auth.js'
import { parseFilters } from '../filters.js'
import { ok, paginated, parsePagination } from '../../utils/pagination.js'

/**
 * Favorites sub-tab.
 *
 * `GET /api/favorites` returns saved consultations already joined to their
 * awards, so the tab renders from a single request. It accepts the same filter
 * parameters as the main listing, which lets the UI reuse its filter component
 * inside the sub-tab. A favourite points at a consultation id.
 */
export function favoriteRoutes({ services }) {
  const router = Router()
  router.use(requireAuth(services.auth))

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const filters = parseFilters(req.query)
      const pagination = parsePagination(req.query)
      const { data, total } = await services.favorites.list(req.user.id, filters, {
        ...pagination,
        sort: req.query.sort,
      })
      res.json({ ...paginated(data, total, pagination), filters })
    }),
  )

  router.get(
    '/count',
    asyncHandler(async (req, res) => {
      res.json(ok({ count: await services.favorites.count(req.user.id) }))
    }),
  )

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const favorite = await services.favorites.add(req.user.id, req.body.consultationId ?? req.body.id, {
        note: req.body.note,
        tags: req.body.tags,
      })
      res.status(201).json(ok(favorite))
    }),
  )

  router.delete(
    '/:consultationId',
    asyncHandler(async (req, res) => {
      res.json(ok(await services.favorites.remove(req.user.id, req.params.consultationId)))
    }),
  )

  // Saved searches live alongside favourites: both are "what this user is
  // watching", and both are per account.
  router.get(
    '/searches',
    asyncHandler(async (req, res) => res.json(ok(await services.savedSearches.list(req.user.id)))),
  )

  router.post(
    '/searches',
    asyncHandler(async (req, res) => res.status(201).json(ok(await services.savedSearches.create(req.user.id, req.body)))),
  )

  router.patch(
    '/searches/:id/active',
    asyncHandler(async (req, res) =>
      res.json(ok(await services.savedSearches.setActive(Number(req.params.id), req.user.id, req.body.isActive === true))),
    ),
  )

  router.delete(
    '/searches/:id',
    asyncHandler(async (req, res) => res.json(ok(await services.savedSearches.remove(Number(req.params.id), req.user.id)))),
  )

  return router
}
