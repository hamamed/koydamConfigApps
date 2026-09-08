import PDFDocument from 'pdfkit'
import { config } from '../config/index.js'
import { formatAmount } from '../utils/money.js'
import { resolveTheme } from './invoiceTheme.js'

/*
  The panel's own tokens, so an invoice and the screen that made it read as one
  product. These are the values in shell-open.ejs `:root` — --text, --muted,
  --line, --accent-soft — not approximations of them; when the panel's palette
  moves, these move with it.
*/
const COLORS = {
  text: '#111827',
  muted: '#6b7280',
  line: '#e5e9f0',
  faint: '#eaf1fa',
  hairline: '#eef1f5',
  reverse: '#ffffff',
}
/** --radius, in points: the panel rounds its cards and so does the paper. */
const RADIUS = 6
const MIN_ROW_HEIGHT = 22

/**
 * The line every invoice carries, whatever else it is made to look like.
 *
 * Set faintly and drawn on every page, including ones the table spills onto.
 * It is not a setting: an invoice produced here says so, quietly, the way a
 * printer's mark does.
 */
const MARK = { text: 'Établie avec CivicTrust', opacity: 0.28, size: 7.5 }

/** Column layout of the line-item table, as fractions of the content width. */
/*
  Widths as fractions of the content width, sized for the largest text a
  person can choose: every one of these has to hold its own bold heading and
  its widest value on one line. "3.000,00 MAD" broken across two lines reads
  as two numbers, and "Unité" broken after "Unit" reads as a typo.
*/
const COLUMNS = [
  { key: 'position', label: 'N°', width: 0.06, align: 'left' },
  { key: 'designation', label: 'Désignation', width: 0.33, align: 'left' },
  { key: 'lot', label: 'Lot', width: 0.075, align: 'center' },
  { key: 'quantity', label: 'Qté', width: 0.075, align: 'right' },
  { key: 'unit', label: 'Unité', width: 0.09, align: 'center' },
  { key: 'unitPrice', label: 'P.U. HT', width: 0.17, align: 'right' },
  { key: 'total', label: 'Total HT', width: 0.2, align: 'right' },
]

/**
 * Renders an invoice as a PDF into any writable stream.
 *
 * @param {object} invoice invoice row including its `items`.
 * @param {import('node:stream').Writable} stream destination.
 * @param {object} [options]
 * @param {object} [options.theme] from resolveTheme; the issuer block, the
 *   template, the logo and the sizes. Defaults to the installation's own.
 * @returns {Promise<void>} resolves once the stream has been fully written.
 */
export function renderInvoicePdf(invoice, stream, options = {}) {
  const theme = options.theme ?? resolveTheme(null, config.company)
  const margin = theme.density.margin

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin,
      info: { Title: `Facture ${invoice.invoice_number}`, Author: theme.issuer.name },
    })

    stream.on('finish', resolve)
    stream.on('error', reject)
    doc.on('error', reject)
    doc.pipe(stream)

    // Every page, not only the first: a long invoice runs onto a second one.
    // `pageAdded` does not fire for the page a document opens with, so that
    // one is marked here, before anything is drawn over it.
    doc.on('pageAdded', () => drawMark(doc, theme))
    drawMark(doc, theme)

    const context = { doc, theme, margin, size: (points) => points * theme.density.scale }
    const currency = invoice.currency || config.invoice.currency

    drawHeader(context, invoice)
    drawParties(context, invoice)
    drawConsultationBlock(context, invoice)
    const tableBottom = drawItems(context, invoice.items ?? [], currency)
    drawTotals(context, invoice, currency, tableBottom)
    drawNotes(context, invoice)

    doc.end()
  })
}

const contentWidth = (doc, margin) => doc.page.width - margin * 2

/* -------------------------------------------------------------- the header */

function drawHeader(context, invoice) {
  if (context.theme.template.banner) return drawBannerHeader(context, invoice)
  if (context.theme.template.key === 'epure') return drawCentredHeader(context, invoice)
  return drawRuledHeader(context, invoice)
}

/** Logo and issuer left, invoice details right, a rule underneath. */
function drawRuledHeader(context, invoice) {
  const { doc, theme, margin, size } = context
  const top = margin
  let cursor = top

  const logoHeight = drawLogo(context, margin, cursor, theme.template.logo)
  if (logoHeight) cursor += logoHeight + size(8)

  doc.font(theme.font.bold).fontSize(size(18)).fillColor(theme.accent).text(theme.issuer.name, margin, cursor)
  doc.font(theme.font.regular).fontSize(size(9)).fillColor(COLORS.muted)
  issuerLines(theme).forEach((line) => doc.text(line))

  drawDetails(context, invoice, { top, color: COLORS.text, muted: COLORS.muted })

  doc.y = Math.max(doc.y, top + size(70))
  doc.moveDown(1)
  rule(context, doc.y)
}

/**
 * A coloured band with everything reversed out of it.
 *
 * The band is measured before it is drawn. Fixed at a guessed height it fits
 * an issuer with a short address and, with a logo above four lines of address,
 * lets the last of them fall past the colour — pale text on white paper, which
 * reads as missing rather than as small.
 */
function drawBannerHeader(context, invoice) {
  const { doc, theme, margin, size } = context
  const padTop = size(26)
  const padBottom = size(18)
  const lines = issuerLines(theme)

  const logoHeight = theme.logo ? size(theme.template.logo.maxHeight) * theme.logo.scale : 0
  const left = logoHeight + (logoHeight ? size(6) : 0) + size(17) * 1.2 + lines.length * size(8.5) * 1.35
  const right = size(16) * 1.2 + detailLines(invoice).length * size(9.5) * 1.35
  const height = padTop + Math.max(left, right) + padBottom

  doc.rect(0, 0, doc.page.width, height).fill(theme.accent)

  let cursor = padTop
  if (logoHeight) cursor += drawLogo(context, margin, cursor, theme.template.logo) + size(6)

  doc.font(theme.font.bold).fontSize(size(17)).fillColor(COLORS.reverse).text(theme.issuer.name, margin, cursor)
  doc.font(theme.font.regular).fontSize(size(8.5)).fillColor('#dbe7f3')
  lines.forEach((line) => doc.text(line))

  drawDetails(context, invoice, { top: padTop, color: COLORS.reverse, muted: '#dbe7f3' })

  doc.y = height + size(18)
}

/** Logo, issuer and details stacked and centred, hairline under them. */
function drawCentredHeader(context, invoice) {
  const { doc, theme, margin, size } = context
  const width = contentWidth(doc, margin)
  let cursor = margin

  const logoHeight = drawLogo(context, margin, cursor, theme.template.logo, width)
  if (logoHeight) cursor += logoHeight + size(10)

  doc.font(theme.font.bold).fontSize(size(16)).fillColor(COLORS.text)
    .text(theme.issuer.name, margin, cursor, { width, align: 'center' })
  doc.font(theme.font.regular).fontSize(size(8.5)).fillColor(COLORS.muted)
  issuerLines(theme).forEach((line) => doc.text(line, margin, doc.y, { width, align: 'center' }))

  doc.moveDown(1)
  rule(context, doc.y, COLORS.line)
  doc.moveDown(0.8)

  doc.font(theme.font.bold).fontSize(size(13)).fillColor(theme.accent)
    .text('FACTURE', margin, doc.y, { width, align: 'center' })
  doc.font(theme.font.regular).fontSize(size(9)).fillColor(COLORS.muted)
    .text(detailLines(invoice).join('   ·   '), margin, doc.y + size(3), { width, align: 'center' })
  doc.moveDown(1)
  rule(context, doc.y)
}

/** The "FACTURE / number / dates" block, wherever a template puts it. */
function drawDetails(context, invoice, { top, color, muted }) {
  const { doc, theme, margin, size } = context
  const boxWidth = size(210)
  const left = doc.page.width - margin - boxWidth
  const saved = doc.y

  doc.font(theme.font.bold).fontSize(size(16)).fillColor(color)
    .text('FACTURE', left, top, { width: boxWidth, align: 'right' })
  doc.font(theme.font.regular).fontSize(size(9.5)).fillColor(muted)
  detailLines(invoice).forEach((line) => doc.text(line, { width: boxWidth, align: 'right' }))

  doc.y = Math.max(saved, doc.y)
}

const detailLines = (invoice) => [
  `N° ${invoice.invoice_number}`,
  `Date d'émission : ${invoice.issue_date}`,
  ...(invoice.due_date ? [`Échéance : ${invoice.due_date}`] : []),
  `Statut : ${invoice.status}`,
]

const issuerLines = (theme) => [
  theme.issuer.address, theme.issuer.email, theme.issuer.phone,
  theme.issuer.ice ? `ICE : ${theme.issuer.ice}` : '',
].filter(Boolean)

/**
 * Draws the logo, bounded by the template's height and the person's scale.
 * @returns {number} the height used, or 0 when there is no usable logo.
 */
function drawLogo(context, x, y, spec, availableWidth = null) {
  const { doc, theme, size } = context
  if (!theme.logo) return 0

  const height = size(spec.maxHeight) * theme.logo.scale
  const width = height * 4   // a generous box; `fit` keeps the aspect ratio

  try {
    const buffer = Buffer.from(theme.logo.data, 'base64')
    const left = spec.align === 'center' && availableWidth
      ? x + (availableWidth - width) / 2
      : x
    doc.image(buffer, left, y, { fit: [width, height], align: spec.align })
    return height
  } catch {
    // A logo that PDFKit will not decode must not cost somebody their invoice.
    // It was checked on upload; anything surviving that is not worth a 500.
    return 0
  }
}

/* --------------------------------------------------------------- the body */

function drawParties(context, invoice) {
  const { doc, theme, margin, size } = context
  const centred = theme.template.key === 'epure'
  const width = centred ? contentWidth(doc, margin) : contentWidth(doc, margin) / 2
  const top = doc.y + size(14)

  doc.font(theme.font.bold).fontSize(size(10)).fillColor(COLORS.text)
    .text('Facturé à', margin, top, { width, align: centred ? 'center' : 'left' })
  doc.font(theme.font.regular).fillColor(COLORS.text)
    .text(invoice.client_name, { width, align: centred ? 'center' : 'left' })

  doc.fillColor(COLORS.muted).fontSize(size(9))
  if (invoice.client_ice) doc.text(`ICE : ${invoice.client_ice}`, { width, align: centred ? 'center' : 'left' })
  if (invoice.client_address) {
    doc.text(invoice.client_address, { width, align: centred ? 'center' : 'left' })
  }
  doc.moveDown(1)
}

function drawConsultationBlock(context, invoice) {
  const { doc, theme, margin, size } = context
  if (!invoice.consultation_reference) return
  const top = doc.y + size(6)
  const height = size(26)

  if (theme.template.key === 'epure') {
    doc.font(theme.font.bold).fontSize(size(9)).fillColor(COLORS.muted)
      .text('Consultation : ', margin, top, { continued: true })
      .font(theme.font.regular).text(invoice.consultation_reference)
    doc.y = top + height
    return
  }

  doc.roundedRect(margin, top, contentWidth(doc, margin), height, RADIUS)
    .fillAndStroke(COLORS.faint, COLORS.line)
  doc.fillColor(COLORS.text).font(theme.font.bold).fontSize(size(9))
    .text('Consultation : ', margin + size(10), top + size(9), { continued: true })
    .font(theme.font.regular).text(invoice.consultation_reference)
  doc.y = top + height + size(8)
}

/** @returns {number} the Y coordinate just below the table. */
function drawItems(context, items, currency) {
  const { doc, theme, margin, size } = context
  const width = contentWidth(doc, margin)
  const padding = theme.density.rowPadding
  const columns = COLUMNS.map((column) => ({ ...column, pixels: column.width * width }))
  let cursor = doc.y + size(8)

  cursor = drawTableHeader(context, columns, cursor)

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

    doc.font(theme.font.regular).fontSize(size(9)).fillColor(COLORS.text)
    const designation = columns.find((column) => column.key === 'designation')
    const height = Math.max(
      size(MIN_ROW_HEIGHT),
      doc.heightOfString(values.designation, { width: designation.pixels - padding * 2 }) + padding * 2,
    )

    // Leave room for the mark: a row printed over it reads as a smudge.
    if (cursor + height > doc.page.height - margin - size(26)) {
      doc.addPage()
      cursor = drawTableHeader(context, columns, margin)
    }

    let left = margin
    for (const column of columns) {
      doc.text(values[column.key] ?? '', left + padding, cursor + padding, {
        width: column.pixels - padding * 2,
        align: column.align,
      })
      left += column.pixels
    }

    cursor += height
    rule(context, cursor, COLORS.hairline)
  }

  return cursor
}

function drawTableHeader(context, columns, top) {
  const { doc, theme, margin, size } = context
  const height = size(22)
  const padding = theme.density.rowPadding
  const ruled = theme.template.tableHeader === 'ruled'

  if (ruled) {
    rule(context, top, COLORS.text)
    doc.font(theme.font.bold).fontSize(size(8.5)).fillColor(COLORS.text)
  } else {
    // Rounded at the top only, the way a table sits inside a card on screen.
    doc.roundedRect(margin, top, contentWidth(doc, margin), height, RADIUS).fill(theme.accent)
    doc.rect(margin, top + height - RADIUS, contentWidth(doc, margin), RADIUS).fill(theme.accent)
    doc.font(theme.font.bold).fontSize(size(9)).fillColor(COLORS.reverse)
  }

  let left = margin
  for (const column of columns) {
    doc.text(column.label, left + padding, top + padding, {
      width: column.pixels - padding * 2,
      align: column.align,
    })
    left += column.pixels
  }

  if (ruled) rule(context, top + height, COLORS.line)
  doc.fillColor(COLORS.text)
  return top + height
}

function drawTotals(context, invoice, currency, tableBottom) {
  const { doc, theme, margin, size } = context
  const boxWidth = size(240)
  const left = doc.page.width - margin - boxWidth
  const padding = theme.density.rowPadding
  let cursor = tableBottom + size(16)

  const lines = [
    ['Total HT', formatAmount(invoice.subtotal_cents, currency)],
    ...(invoice.discount_cents > 0 ? [['Remise', `- ${formatAmount(invoice.discount_cents, currency)}`]] : []),
    [`TVA (${invoice.tax_rate} %)`, formatAmount(invoice.tax_cents, currency)],
  ]

  doc.font(theme.font.regular).fontSize(size(10)).fillColor(COLORS.text)
  for (const [label, value] of lines) {
    doc.text(label, left, cursor, { width: boxWidth / 2 })
    doc.text(value, left + boxWidth / 2, cursor, { width: boxWidth / 2, align: 'right' })
    cursor += size(18)
  }

  const height = size(28)
  if (theme.template.key === 'epure') {
    rule(context, cursor, COLORS.text, left)
    doc.font(theme.font.bold).fontSize(size(11)).fillColor(COLORS.text)
  } else {
    doc.roundedRect(left, cursor, boxWidth, height, RADIUS).fill(theme.accent)
    doc.font(theme.font.bold).fontSize(size(11)).fillColor(COLORS.reverse)
  }

  const baseline = cursor + (theme.template.key === 'epure' ? size(8) : size(9))
  doc.text('Total TTC', left + padding, baseline, { width: boxWidth / 2 })
    .text(formatAmount(invoice.total_cents, currency), left + boxWidth / 2, baseline, {
      width: boxWidth / 2 - padding,
      align: 'right',
    })

  doc.y = cursor + height + size(12)
  doc.fillColor(COLORS.text)
}

function drawNotes(context, invoice) {
  const { doc, theme, margin, size } = context
  const note = [invoice.notes, theme.footerNote].filter(Boolean).join('\n')
  if (!note) return

  doc.font(theme.font.bold).fontSize(size(9)).fillColor(COLORS.text).text('Notes', margin, doc.y)
  doc.font(theme.font.regular).fillColor(COLORS.muted)
    .text(note, { width: contentWidth(doc, margin) })
}

/* ---------------------------------------------------------------- the mark */

function drawMark(doc, theme) {
  const margin = theme.density.margin
  const bottom = doc.page.height - margin
  const saved = { x: doc.x, y: doc.y }

  doc.save()
  doc.fillOpacity(MARK.opacity)
  doc.strokeOpacity(MARK.opacity)
  doc.strokeColor(COLORS.line).lineWidth(0.5)
    .moveTo(margin, bottom - 18).lineTo(doc.page.width - margin, bottom - 18).stroke()
  doc.font(theme.font.regular).fontSize(MARK.size).fillColor(COLORS.muted)
    .text(MARK.text, margin, bottom - 12, { width: doc.page.width - margin * 2, align: 'center', lineBreak: false })
  doc.restore()

  doc.x = saved.x
  doc.y = saved.y
}

function rule(context, y, color = COLORS.line, from = null) {
  const { doc, margin } = context
  doc.strokeColor(color).lineWidth(0.5)
    .moveTo(from ?? margin, y).lineTo(doc.page.width - margin, y).stroke()
}

const formatQuantity = (quantity) =>
  Number.isInteger(Number(quantity)) ? String(Number(quantity)) : Number(quantity).toFixed(2)
