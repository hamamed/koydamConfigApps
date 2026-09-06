import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config/index.js'
import { serializeInvoice } from './serializers.js'
import { NotFoundError, ValidationError } from '../utils/errors.js'
import { applyRate, lineTotalCentimes, toCentimes } from '../utils/money.js'
import { nowIso, isIsoDate } from '../utils/dates.js'
import { clean } from '../utils/text.js'
import { renderInvoicePdf } from '../pdf/invoiceDocument.js'

const SEQUENCE_PADDING = 4
const MAX_ITEMS = 200
const VALID_STATUSES = new Set(['draft', 'issued', 'paid', 'cancelled'])

/**
 * Builds invoices from the article/lot breakdown of a consultation.
 *
 * All arithmetic runs in integer centimes; the decimal amounts in API payloads
 * are produced at the serialization boundary only.
 */
export function createInvoiceService({ invoices, articles, consultations }) {
  /**
   * @param {number|null} userId author of the invoice.
   * @param {object} payload see `normalizeItems` for the item shape.
   * @returns {Promise<object>} serialized invoice with its line items.
   */
  async function create(userId, payload = {}) {
    const consultationId = payload.consultationId ? Number(payload.consultationId) : null
    const consultation = consultationId ? await consultations.findById(consultationId) : null
    if (consultationId && !consultation) throw new NotFoundError(`Consultation ${payload.consultationId}`)

    const clientName = clean(payload.client?.name)
    if (!clientName) throw new ValidationError('client.name is required')

    const issueDate = payload.issueDate ?? nowIso().slice(0, 10)
    if (!isIsoDate(issueDate)) throw new ValidationError('issueDate must be an ISO date (YYYY-MM-DD)')
    if (payload.dueDate && !isIsoDate(payload.dueDate)) {
      throw new ValidationError('dueDate must be an ISO date (YYYY-MM-DD)')
    }

    const status = payload.status ?? 'draft'
    if (!VALID_STATUSES.has(status)) {
      throw new ValidationError(`status must be one of ${[...VALID_STATUSES].join(', ')}`)
    }

    const items = await normalizeItems(payload.items, consultation)
    const totals = computeTotals(items, {
      taxRate: payload.taxRate ?? config.invoice.taxRate,
      discountCents: toCentimes(payload.discount) ?? 0,
    })

    const timestamp = nowIso()
    const invoiceNumber = await nextInvoiceNumber(issueDate.slice(0, 4))

    const created = await invoices.create(
      {
        invoice_number: invoiceNumber,
        user_id: userId,
        consultation_id: consultation?.id ?? null,
        client_name: clientName,
        client_ice: clean(payload.client?.ice) || null,
        client_address: clean(payload.client?.address) || null,
        issue_date: issueDate,
        due_date: payload.dueDate ?? null,
        currency: payload.currency ?? config.invoice.currency,
        subtotal_cents: totals.subtotalCents,
        discount_cents: totals.discountCents,
        tax_rate: totals.taxRate,
        tax_cents: totals.taxCents,
        total_cents: totals.totalCents,
        status,
        notes: clean(payload.notes) || null,
        created_at: timestamp,
        updated_at: timestamp,
      },
      items,
    )

    return serializeInvoice(created)
  }

  /**
   * Resolves the requested lines into invoice items.
   *
   * An item either references a scraped article (`articleId`, whose designation
   * and unit are copied from the DB) or is entirely free-form. Quantity and unit
   * price supplied by the caller always win, since the portal's estimates are
   * frequently blank.
   */
  async function normalizeItems(rawItems, consultation) {
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      throw new ValidationError('At least one invoice item is required')
    }
    if (rawItems.length > MAX_ITEMS) {
      throw new ValidationError(`An invoice cannot hold more than ${MAX_ITEMS} items`)
    }

    const ids = rawItems.map((item) => item.articleId).filter((id) => Number.isInteger(id))
    const found = ids.length > 0 ? await articles.findByIds(ids) : []
    const byId = new Map(found.map((article) => [article.id, article]))

    const missing = ids.filter((id) => !byId.has(id))
    if (missing.length > 0) throw new ValidationError(`Unknown article ids: ${missing.join(', ')}`)

    if (consultation) {
      const foreign = found.filter((article) => article.consultation_id !== consultation.id)
      if (foreign.length > 0) {
        throw new ValidationError(
          `Articles ${foreign.map((article) => article.id).join(', ')} do not belong to consultation ${consultation.id}`,
        )
      }
    }

    return rawItems.map((item, index) => {
      const article = byId.get(item.articleId)
      const designation = clean(item.designation) || article?.designation
      if (!designation) throw new ValidationError(`items[${index}].designation is required`)

      const quantity = Number(item.quantity ?? article?.quantity ?? 1)
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new ValidationError(`items[${index}].quantity must be a positive number`)
      }

      const unitPriceCents = item.unitPrice !== undefined ? toCentimes(item.unitPrice) : article?.unit_price_cents ?? null
      if (unitPriceCents === null || unitPriceCents < 0) {
        throw new ValidationError(`items[${index}].unitPrice must be a non-negative amount`)
      }

      return {
        consultation_article_id: article?.id ?? null,
        position: index,
        lot_number: clean(item.lotNumber) || article?.lot_number || null,
        designation,
        description: clean(item.description) || article?.description || null,
        unit: clean(item.unit) || article?.unit || null,
        quantity,
        unit_price_cents: unitPriceCents,
        line_total_cents: lineTotalCentimes(quantity, unitPriceCents),
      }
    })
  }

  /** Subtotal -> discount -> VAT -> total, entirely in centimes. */
  function computeTotals(items, { taxRate, discountCents }) {
    const subtotalCents = items.reduce((sum, item) => sum + item.line_total_cents, 0)
    if (discountCents < 0 || discountCents > subtotalCents) {
      throw new ValidationError('discount must be between 0 and the invoice subtotal')
    }
    const rate = Number(taxRate)
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      throw new ValidationError('taxRate must be a percentage between 0 and 100')
    }
    const taxableCents = subtotalCents - discountCents
    const taxCents = applyRate(taxableCents, rate)
    return { subtotalCents, discountCents, taxRate: rate, taxCents, totalCents: taxableCents + taxCents }
  }

  /** `FCT-2026-0001`, sequential per issue year. */
  async function nextInvoiceNumber(year) {
    const prefix = config.invoice.numberPrefix
    const sequence = (await invoices.maxSequenceForYear(prefix, year)) + 1
    return `${prefix}-${year}-${String(sequence).padStart(SEQUENCE_PADDING, '0')}`
  }

  async function getById(id, userId = null) {
    const invoice = await invoices.findWithItems(id)
    if (!invoice) throw new NotFoundError(`Invoice ${id}`)
    if (userId !== null && invoice.user_id !== null && invoice.user_id !== userId) {
      throw new NotFoundError(`Invoice ${id}`)
    }
    return invoice
  }

  async function list(filters, pagination) {
    const { rows, total } = await invoices.list(filters, pagination)
    return { data: rows.map((row) => serializeInvoice(row)), total }
  }

  async function updateStatus(id, status) {
    if (!VALID_STATUSES.has(status)) {
      throw new ValidationError(`status must be one of ${[...VALID_STATUSES].join(', ')}`)
    }
    await getById(id)
    return serializeInvoice(await invoices.update(id, { status }))
  }

  async function remove(id) {
    await getById(id)
    await invoices.remove(id)
    return { id, deleted: true }
  }

  /** Streams the invoice PDF into `stream` (an HTTP response or a file). */
  async function streamPdf(id, stream, userId = null) {
    const invoice = await getById(id, userId)
    return renderInvoicePdf(invoice, stream)
  }

  /** Renders the PDF to disk and stores its path on the invoice row. */
  async function savePdf(id) {
    const invoice = await getById(id)
    await fs.mkdir(config.invoice.storageDir, { recursive: true })
    const filePath = path.join(config.invoice.storageDir, `${invoice.invoice_number}.pdf`)
    const handle = await fs.open(filePath, 'w')
    try {
      await renderInvoicePdf(invoice, handle.createWriteStream())
    } finally {
      await handle.close().catch(() => {})
    }
    await invoices.update(id, { pdf_path: filePath })
    return filePath
  }

  return { create, getById, list, updateStatus, remove, streamPdf, savePdf, computeTotals, normalizeItems }
}
