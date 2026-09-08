import test from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { inflateSync } from 'node:zlib'
import { renderInvoicePdf } from '../src/pdf/invoiceDocument.js'
import { resolveTheme, TEMPLATES, DENSITIES } from '../src/pdf/invoiceTheme.js'
import { createInvoiceBrandingService } from '../src/services/invoiceBrandingService.js'

/** Collects a PDF into memory so its bytes can be looked at. */
const render = async (invoice, options) => {
  const chunks = []
  const sink = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done() } })
  await renderInvoicePdf(invoice, sink, options)
  return Buffer.concat(chunks)
}

/** An invoice long enough to run onto a second page. */
const invoiceOf = (lines) => ({
  invoice_number: 'FA-2026-0001',
  issue_date: '2026-09-08',
  due_date: '2026-10-08',
  status: 'draft',
  currency: 'MAD',
  client_name: 'Commune de Rabat',
  client_ice: '001122334455667',
  client_address: 'Avenue Mohammed V, Rabat',
  consultation_reference: '07/2026',
  subtotal_cents: 100_000 * lines,
  discount_cents: 5_000,
  tax_rate: 20,
  tax_cents: 20_000 * lines,
  total_cents: 120_000 * lines,
  notes: 'Règlement à 30 jours.',
  items: Array.from({ length: lines }, (_, index) => ({
    designation: `Prestation ${index + 1} — fourniture, pose et mise en service sur site`,
    lot_number: '1', quantity: 2, unit: 'U',
    unit_price_cents: 50_000, line_total_cents: 100_000,
  })),
})

/** The smallest valid PNG, as a browser would hand it over. */
const PNG = `data:image/png;base64,${Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
  '1f15c4890000000a49444154789c6360000002000100ffff0300000600' +
  '0557bfabd40000000049454e44ae426082', 'hex').toString('base64')}`

test('every template renders a PDF, at every size', async () => {
  for (const template of Object.keys(TEMPLATES)) {
    for (const density of Object.keys(DENSITIES)) {
      const theme = resolveTheme({ template, density, accent: '#8a1f4b' }, { name: 'Atelier Nour' })
      const pdf = await render(invoiceOf(3), { theme })
      assert.ok(pdf.length > 900, `${template}/${density} produced ${pdf.length} bytes`)
      assert.equal(pdf.subarray(0, 5).toString(), '%PDF-', `${template}/${density} is not a PDF`)
      assert.ok(pdf.includes('%%EOF'), `${template}/${density} was never finished`)
    }
  }
})

test('the CivicTrust line is on every page, including the ones a long invoice spills onto', async () => {
  const theme = resolveTheme(null, { name: 'Atelier Nour' })
  const short = await render(invoiceOf(2), { theme })
  const long = await render(invoiceOf(60), { theme })

  const pages = (pdf) => (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length
  assert.equal(pages(short), 1, 'the short invoice should be one page')
  assert.ok(pages(long) > 1, 'the long invoice should run onto a second page')

  // PDFKit deflates each page's content, so the drawn text is only legible
  // after inflating it — and it is per page, which is the point: a mark drawn
  // once would appear in one stream however many pages there are.
  const marks = (pdf) => text(pdf).filter((page) => page.includes('CivicTrust')).length
  assert.equal(marks(short), 1, 'the mark is missing from a one-page invoice')
  assert.equal(marks(long), pages(long), 'the mark did not follow onto the later pages')
})

test('a logo is accepted only when its bytes are an image a PDF can carry', async () => {
  const saved = []
  const branding = {
    forUser: async () => null,
    save: async (userId, patch) => { saved.push(patch); return { user_id: userId, ...patch } },
    clearLogo: async () => null,
  }
  const service = createInvoiceBrandingService({ invoiceBranding: branding, settings: null })

  await service.save(1, { template: 'moderne', density: 'compact', accent: '#123456', logo: PNG })
  assert.equal(saved[0].logo_mime, 'image/png')
  assert.ok(saved[0].logo_data.length > 0)

  // A file that says it is a PNG and is not: the declared type is not the fact.
  const lying = `data:image/png;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`
  await assert.rejects(() => service.save(1, { logo: lying }), /PNG and JPEG/)

  await assert.rejects(() => service.save(1, { template: 'nope' }), /template/)
  await assert.rejects(() => service.save(1, { accent: 'red' }), /hex/)

  // Saving without touching the file input must not remove the logo.
  saved.length = 0
  await service.save(1, { accent: '#0b5394' })
  assert.ok(!('logo_data' in saved[0]), 'saving a colour cleared the logo')
})

test('an empty field falls back to the installation, and a bad one to a drawable default', async () => {
  const theme = resolveTheme(
    { template: 'unknown', density: 'huge', accent: 'not-a-colour', logo_scale: 99, company_name: '  ' },
    { name: 'Atelier Nour', ice: '00112233', address: 'Rabat' },
  )
  assert.equal(theme.template.key, 'classique')
  assert.equal(theme.density.key, 'normal')
  assert.equal(theme.accent, '#0b5394')
  assert.equal(theme.issuer.name, 'Atelier Nour', 'a blank name should not erase the issuer')
  assert.equal(theme.issuer.address, 'Rabat')

  // And a theme built from nonsense still draws, rather than throwing inside a
  // response that has already begun streaming.
  const pdf = await render(invoiceOf(1), { theme })
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
})

test('a logo that survives upload but not PDFKit costs a page, not the invoice', async () => {
  // Valid base64, real PNG magic, truncated body: decodable as a buffer,
  // undecodable as an image.
  const broken = Buffer.from('89504e470d0a1a0a00000000', 'hex').toString('base64')
  const theme = resolveTheme({ logo_data: broken, logo_mime: 'image/png' }, { name: 'Atelier Nour' })
  const pdf = await render(invoiceOf(1), { theme })
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-', 'a broken logo should not cost the invoice')
})

/**
 * The text drawn on each page of a PDF.
 *
 * Two things are in the way. PDFKit deflates every page's content stream; and
 * inside it, text is a show-array of hex glyph runs separated by kerning
 * numbers, so "CivicTrust" is written `[<436976696354> 120 <72> -15 <757374>]`.
 * Searching the raw bytes finds nothing, and searching the decoded bytes finds
 * "CivicT" and "ust" as separate words. Each array is therefore rebuilt from
 * its hex runs alone, with the kerning dropped.
 *
 * @param {Buffer} pdf
 * @returns {string[]} one string per page-content stream.
 */
function text(pdf) {
  const pages = []
  const raw = pdf.toString('latin1')
  const pattern = /stream\r?\n/g
  let match
  while ((match = pattern.exec(raw)) !== null) {
    const start = match.index + match[0].length
    const end = raw.indexOf('endstream', start)
    if (end < 0) continue
    let body
    try {
      body = inflateSync(pdf.subarray(start, end)).toString('latin1')
    } catch {
      continue          // fonts and metadata live in here too, undeflated
    }
    if (!body.includes('TJ') && !body.includes('Tj')) continue

    const shown = [...body.matchAll(/\[([^\]]*)\]\s*TJ/g)].map(([, inner]) =>
      (inner.match(/<[0-9a-fA-F]*>/g) ?? [])
        .map((run) => Buffer.from(run.slice(1, -1), 'hex').toString('latin1'))
        .join(''))
    pages.push(shown.join('\n'))
  }
  return pages
}
