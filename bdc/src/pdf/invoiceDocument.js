import PDFDocument from 'pdfkit'
import { config } from '../config/index.js'
import { formatAmount } from '../utils/money.js'

const PAGE_MARGIN = 50
const COLORS = { text: '#1f2933', muted: '#7b8794', line: '#cbd2d9', accent: '#0b5394' }
const FONT = { regular: 'Helvetica', bold: 'Helvetica-Bold' }
const ROW_PADDING = 6
const MIN_ROW_HEIGHT = 22

/** Column layout of the line-item table, as fractions of the content width. */
const COLUMNS = [
  { key: 'position', label: 'N°', width: 0.05, align: 'left' },
  { key: 'designation', label: 'Désignation', width: 0.4, align: 'left' },
  { key: 'lot', label: 'Lot', width: 0.08, align: 'center' },
  { key: 'quantity', label: 'Qté', width: 0.09, align: 'right' },
  { key: 'unit', label: 'Unité', width: 0.09, align: 'center' },
  { key: 'unitPrice', label: 'P.U. HT', width: 0.14, align: 'right' },
  { key: 'total', label: 'Total HT', width: 0.15, align: 'right' },
]

/**
 * Renders an invoice as a PDF into any writable stream (an HTTP response for a
 * download, or a file handle for archiving).
 * @param {object} invoice invoice row including its `items`.
 * @param {import('node:stream').Writable} stream destination.
 * @param {object} [company] issuer block; defaults to the environment's.
 * @returns {Promise<void>} resolves once the stream has been fully written.
 */
export function renderInvoicePdf(invoice, stream, company = config.company) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, info: { Title: `Facture ${invoice.invoice_number}` } })

    stream.on('finish', resolve)
    stream.on('error', reject)
    doc.on('error', reject)
    doc.pipe(stream)

    const currency = invoice.currency || config.invoice.currency
    drawHeader(doc, invoice, company)
    drawParties(doc, invoice)
    drawConsultationBlock(doc, invoice)
    const tableBottom = drawItems(doc, invoice.items ?? [], currency)
    drawTotals(doc, invoice, currency, tableBottom)
    drawFooter(doc, invoice, company)

    doc.end()
  })
}

const contentWidth = (doc) => doc.page.width - PAGE_MARGIN * 2

function drawHeader(doc, invoice, company) {
  doc
    .font(FONT.bold)
    .fontSize(18)
    .fillColor(COLORS.accent)
    .text(company.name, PAGE_MARGIN, PAGE_MARGIN)

  doc.font(FONT.regular).fontSize(9).fillColor(COLORS.muted)
  for (const line of [company.address, company.email, company.phone].filter(Boolean)) {
    doc.text(line)
  }
  if (company.ice) doc.text(`ICE : ${company.ice}`)

  const boxWidth = 200
  const boxLeft = doc.page.width - PAGE_MARGIN - boxWidth
  doc
    .font(FONT.bold)
    .fontSize(16)
    .fillColor(COLORS.text)
    .text('FACTURE', boxLeft, PAGE_MARGIN, { width: boxWidth, align: 'right' })
    .font(FONT.regular)
    .fontSize(10)
    .fillColor(COLORS.muted)
    .text(`N° ${invoice.invoice_number}`, { width: boxWidth, align: 'right' })
    .text(`Date d'émission : ${invoice.issue_date}`, { width: boxWidth, align: 'right' })

  if (invoice.due_date) doc.text(`Échéance : ${invoice.due_date}`, { width: boxWidth, align: 'right' })
  doc.text(`Statut : ${invoice.status}`, { width: boxWidth, align: 'right' })

  doc.moveDown(1.5)
  horizontalRule(doc, doc.y)
}

function drawParties(doc, invoice) {
  const top = doc.y + 14
  doc
    .font(FONT.bold)
    .fontSize(10)
    .fillColor(COLORS.text)
    .text('Facturé à', PAGE_MARGIN, top)
    .font(FONT.regular)
    .fillColor(COLORS.text)
    .text(invoice.client_name)

  doc.fillColor(COLORS.muted).fontSize(9)
  if (invoice.client_ice) doc.text(`ICE : ${invoice.client_ice}`)
  if (invoice.client_address) doc.text(invoice.client_address, { width: contentWidth(doc) / 2 })
  doc.moveDown(1)
}

function drawConsultationBlock(doc, invoice) {
  if (!invoice.consultation_reference) return
  const top = doc.y + 6
  doc
    .rect(PAGE_MARGIN, top, contentWidth(doc), 26)
    .fillAndStroke('#f5f7fa', COLORS.line)
    .fillColor(COLORS.text)
    .font(FONT.bold)
    .fontSize(9)
    .text('Consultation : ', PAGE_MARGIN + 10, top + 9, { continued: true })
    .font(FONT.regular)
    .text(invoice.consultation_reference)
  doc.y = top + 34
}

/** @returns {number} the Y coordinate just below the table. */
function drawItems(doc, items, currency) {
  const width = contentWidth(doc)
  const columns = COLUMNS.map((column) => ({ ...column, pixels: column.width * width }))
  let cursor = doc.y + 8

  cursor = drawTableHeader(doc, columns, cursor)

  for (const [index, item] of items.entries()) {
    const values = {
      position: String(index + 1),
      designation: item.designation,
      lot: item.lot_number ?? '-',
      quantity: formatQuantity(item.quantity),
      unit: item.unit ?? '-',
      unitPrice: formatAmount(item.unit_price_cents, currency),
      total: formatAmount(item.line_total_cents, currency),
    }

    doc.font(FONT.regular).fontSize(9).fillColor(COLORS.text)
    const designationColumn = columns.find((column) => column.key === 'designation')
    const height = Math.max(
      MIN_ROW_HEIGHT,
      doc.heightOfString(values.designation, { width: designationColumn.pixels - ROW_PADDING * 2 }) + ROW_PADDING * 2,
    )

    if (cursor + height > doc.page.height - PAGE_MARGIN * 2) {
      doc.addPage()
      cursor = drawTableHeader(doc, columns, PAGE_MARGIN)
    }

    let left = PAGE_MARGIN
    for (const column of columns) {
      doc.text(values[column.key] ?? '', left + ROW_PADDING, cursor + ROW_PADDING, {
        width: column.pixels - ROW_PADDING * 2,
        align: column.align,
      })
      left += column.pixels
    }

    cursor += height
    horizontalRule(doc, cursor, '#eef1f5')
  }

  return cursor
}

function drawTableHeader(doc, columns, top) {
  const height = 22
  doc.rect(PAGE_MARGIN, top, contentWidth(doc), height).fill(COLORS.accent)
  doc.font(FONT.bold).fontSize(9).fillColor('#ffffff')

  let left = PAGE_MARGIN
  for (const column of columns) {
    doc.text(column.label, left + ROW_PADDING, top + ROW_PADDING, {
      width: column.pixels - ROW_PADDING * 2,
      align: column.align,
    })
    left += column.pixels
  }
  doc.fillColor(COLORS.text)
  return top + height
}

function drawTotals(doc, invoice, currency, tableBottom) {
  const boxWidth = 240
  const left = doc.page.width - PAGE_MARGIN - boxWidth
  let cursor = tableBottom + 16

  const lines = [
    ['Total HT', formatAmount(invoice.subtotal_cents, currency)],
    ...(invoice.discount_cents > 0 ? [['Remise', `- ${formatAmount(invoice.discount_cents, currency)}`]] : []),
    [`TVA (${invoice.tax_rate} %)`, formatAmount(invoice.tax_cents, currency)],
  ]

  doc.font(FONT.regular).fontSize(10).fillColor(COLORS.text)
  for (const [label, value] of lines) {
    doc.text(label, left, cursor, { width: boxWidth / 2 })
    doc.text(value, left + boxWidth / 2, cursor, { width: boxWidth / 2, align: 'right' })
    cursor += 18
  }

  doc.rect(left, cursor, boxWidth, 28).fill(COLORS.accent)
  doc
    .font(FONT.bold)
    .fontSize(11)
    .fillColor('#ffffff')
    .text('Total TTC', left + ROW_PADDING, cursor + 9, { width: boxWidth / 2 })
    .text(formatAmount(invoice.total_cents, currency), left + boxWidth / 2, cursor + 9, {
      width: boxWidth / 2 - ROW_PADDING,
      align: 'right',
    })

  doc.y = cursor + 40
  doc.fillColor(COLORS.text)
}

function drawFooter(doc, invoice, company) {
  if (invoice.notes) {
    doc.font(FONT.bold).fontSize(9).fillColor(COLORS.text).text('Notes', PAGE_MARGIN, doc.y)
    doc.font(FONT.regular).fillColor(COLORS.muted).text(invoice.notes, { width: contentWidth(doc) })
  }

  const bottom = doc.page.height - PAGE_MARGIN
  horizontalRule(doc, bottom - 24)
  doc
    .font(FONT.regular)
    .fontSize(8)
    .fillColor(COLORS.muted)
    .text(
      `${company.name}${company.ice ? ` — ICE ${company.ice}` : ''} — Facture ${invoice.invoice_number}`,
      PAGE_MARGIN,
      bottom - 16,
      { width: contentWidth(doc), align: 'center' },
    )
}

function horizontalRule(doc, y, color = COLORS.line) {
  doc.strokeColor(color).lineWidth(0.5).moveTo(PAGE_MARGIN, y).lineTo(doc.page.width - PAGE_MARGIN, y).stroke()
}

const formatQuantity = (quantity) =>
  Number.isInteger(Number(quantity)) ? String(Number(quantity)) : Number(quantity).toFixed(2)
