import { Router } from 'express'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { optionalAuth } from '../middleware/auth.js'
import { parseFilters } from '../filters.js'
import { ok, paginated, parsePagination } from '../../utils/pagination.js'

/**
 * Public consultation endpoints.
 *
 * Every listing accepts the portal's own filter names, so a UI can forward its
 * form state verbatim:
 *   GET /api/consultations?search_consultation_resultats[acheteur]=ANCFCC
 *                         &search_consultation_resultats[categorie]=Travaux
 *                         &datePublicationStart=2026-01-01
 *
 * A consultation is addressed by its numeric id. Its reference is not unique —
 * every buyer numbers its own avis — so `/by-reference/:reference` returns a
 * list rather than one row.
 */
export function consultationRoutes({ services }) {
  const router = Router()
  const withUser = optionalAuth(services.auth)

  router.get(
    '/',
    withUser,
    asyncHandler(async (req, res) => {
      const filters = parseFilters(req.query)
      const pagination = parsePagination(req.query)
      const { data, total } = await services.consultations.search(
        filters,
        { ...pagination, sort: req.query.sort },
        req.user?.id ?? null,
      )
      res.json({ ...paginated(data, total, pagination), filters })
    }),
  )

  /**
   * Every consultation published under a reference. References repeat across
   * buyers ("07/2026" belongs to three communes on one page of the portal), so
   * this is a search that returns a list, not a lookup.
   */
  router.get(
    '/by-reference/:reference',
    asyncHandler(async (req, res) => {
      res.json(ok(await services.consultations.findByReference(req.params.reference)))
    }),
  )

  router.get(
    '/:id',
    withUser,
    asyncHandler(async (req, res) => {
      res.json(ok(await services.consultations.getById(Number(req.params.id), req.user?.id ?? null)))
    }),
  )

  /** Article breakdown — the selectable input of the invoice generator. */
  router.get(
    '/:id/articles',
    asyncHandler(async (req, res) => {
      res.json(ok(await services.consultations.listArticles(Number(req.params.id))))
    }),
  )

  /** The award linked to this consultation, if one has been published. */
  router.get(
    '/:id/result',
    asyncHandler(async (req, res) => {
      res.json(ok(await services.consultations.getResultForConsultation(Number(req.params.id))))
    }),
  )

  return router
}
