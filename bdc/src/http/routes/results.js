import { Router } from 'express'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { parseFilters } from '../filters.js'
import { ok, paginated, parsePagination } from '../../utils/pagination.js'

/** Public endpoints over the awards dataset. */
export function resultRoutes({ services }) {
  const router = Router()

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const filters = parseFilters(req.query)
      const pagination = parsePagination(req.query)
      const { data, total } = await services.consultations.searchResults(filters, {
        ...pagination,
        sort: req.query.sort,
      })
      res.json({ ...paginated(data, total, pagination), filters })
    }),
  )

  router.get(
    '/:reference',
    asyncHandler(async (req, res) => {
      res.json(ok(await services.consultations.getResultByReference(req.params.reference)))
    }),
  )

  return router
}
