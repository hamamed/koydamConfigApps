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

  router.get(
    '/:reference',
    withUser,
    asyncHandler(async (req, res) => {
      const consultation = await services.consultations.getByReference(req.params.reference, req.user?.id ?? null)
      res.json(ok(consultation))
    }),
  )

  /** Article/lot breakdown — the selectable input of the invoice generator. */
  router.get(
    '/:reference/articles',
    asyncHandler(async (req, res) => {
      res.json(ok(await services.consultations.listArticles(req.params.reference)))
    }),
  )

  /** The award matched to this consultation by reference, if published. */
  router.get(
    '/:reference/result',
    asyncHandler(async (req, res) => {
      res.json(ok(await services.consultations.getResultByReference(req.params.reference)))
    }),
  )

  return router
}
