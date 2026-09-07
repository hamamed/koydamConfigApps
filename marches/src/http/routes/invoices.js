import { Router } from 'express'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { requireAuth } from '../middleware/auth.js'
import { ok, paginated, parsePagination } from '../../utils/pagination.js'
import { serializeInvoice } from '../../services/serializers.js'

/**
 * Invoice generator.
 *
 * POST /api/invoices
 * {
 *   "consultationId": 1234,
 *   "client": { "name": "...", "ice": "...", "address": "..." },
 *   "items": [
 *     { "articleId": 42, "quantity": 10, "unitPrice": 1250.5 },
 *     { "designation": "Prestation hors lot", "quantity": 1, "unitPrice": 8000 }
 *   ],
 *   "taxRate": 20, "discount": 0, "dueDate": "2026-10-30", "notes": "..."
 * }
 * Totals are computed server-side; client-sent totals are ignored.
 */
export function invoiceRoutes({ services }) {
  const router = Router()
  router.use(requireAuth(services.auth))

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const pagination = parsePagination(req.query)
      const filters = {
        userId: req.user.role === 'admin' && req.query.all === 'true' ? undefined : req.user.id,
        consultationId: req.query.consultationId,
        status: req.query.status,
      }
      const { data, total } = await services.invoices.list(filters, { ...pagination, sort: req.query.sort })
      res.json(paginated(data, total, pagination))
    }),
  )

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      res.status(201).json(ok(await services.invoices.create(req.user.id, req.body)))
    }),
  )

  /** Dry run: returns the computed totals without persisting anything. */
  router.post(
    '/preview',
    asyncHandler(async (req, res) => {
      const items = await services.invoices.normalizeItems(req.body.items, null)
      const totals = services.invoices.computeTotals(items, {
        taxRate: req.body.taxRate ?? undefined,
        discountCents: Math.round(Number(req.body.discount ?? 0) * 100),
      })
      res.json(ok({ items, totals }))
    }),
  )

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const scope = req.user.role === 'admin' ? null : req.user.id
      res.json(ok(serializeInvoice(await services.invoices.getById(Number(req.params.id), scope))))
    }),
  )

  /** Streams the generated PDF as a download. */
  router.get(
    '/:id/pdf',
    asyncHandler(async (req, res) => {
      const scope = req.user.role === 'admin' ? null : req.user.id
      const invoice = await services.invoices.getById(Number(req.params.id), scope)
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `attachment; filename="${invoice.invoice_number}.pdf"`)
      await services.invoices.streamPdf(invoice.id, res, scope)
    }),
  )

  router.patch(
    '/:id/status',
    asyncHandler(async (req, res) => {
      res.json(ok(await services.invoices.updateStatus(Number(req.params.id), req.body.status)))
    }),
  )

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      res.json(ok(await services.invoices.remove(Number(req.params.id))))
    }),
  )

  return router
}
