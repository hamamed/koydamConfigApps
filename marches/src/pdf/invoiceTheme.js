/**
 * What an invoice may be made to look like, and the vocabulary for saying it.
 *
 * Three templates rather than a free layout. A person billing a ministry wants
 * an invoice that looks deliberate, not a page they have to position by hand —
 * and a template that has been drawn once cannot be dragged into a shape that
 * overlaps its own totals. What is free is what a business actually varies:
 * its identity, its logo, its colour, and how much fits on a page.
 */

/** Where each template puts the issuer, the logo, and the invoice's own details. */
export const TEMPLATES = Object.freeze({
  /* Issuer top-left under the logo, invoice details right, ruled header. */
  classique: Object.freeze({
    key: 'classique',
    banner: false,
    logo: { align: 'left', maxHeight: 46 },
    issuer: { align: 'left', beside: 'details' },
    details: { align: 'right' },
    tableHeader: 'filled',
  }),
  /* A coloured band across the top: logo and name reversed out of the accent,
     details in the band, the page below it plain. */
  moderne: Object.freeze({
    key: 'moderne',
    banner: true,
    logo: { align: 'left', maxHeight: 40 },
    issuer: { align: 'left', beside: 'details', onBanner: true },
    details: { align: 'right', onBanner: true },
    tableHeader: 'filled',
  }),
  /* No fills at all: hairlines, wide margins, the logo centred over a centred
     issuer block. For invoices that are printed and filed. */
  epure: Object.freeze({
    key: 'epure',
    banner: false,
    logo: { align: 'center', maxHeight: 52 },
    issuer: { align: 'center', beside: null },
    details: { align: 'center' },
    tableHeader: 'ruled',
  }),
})

/**
 * The typefaces on offer.
 *
 * These are the ones a PDF reader is required to have, so an invoice looks the
 * same on the machine it is opened on as on the one that made it. Embedding
 * the panel's own face would mean carrying a font file through the deploy and
 * would still not match, because the panel asks for whatever the reader's
 * system calls `system-ui`. Helvetica is the nearest thing every reader can be
 * relied on to draw, so it is the default.
 */
export const FONTS = Object.freeze({
  sans: Object.freeze({ key: 'sans', regular: 'Helvetica', bold: 'Helvetica-Bold', css: 'system-ui, -apple-system, "Segoe UI", sans-serif' }),
  serif: Object.freeze({ key: 'serif', regular: 'Times-Roman', bold: 'Times-Bold', css: 'Georgia, "Times New Roman", serif' }),
  mono: Object.freeze({ key: 'mono', regular: 'Courier', bold: 'Courier-Bold', css: 'ui-monospace, "SFMono-Regular", Menlo, monospace' }),
})

/**
 * How much fits on a page. Every size in a template scales by this.
 *
 * Larger text is given a *narrower* margin, not a wider one. The table's
 * columns are fractions of the content width, so growing the type inside a
 * shrinking page is what makes "Unité" break across two lines — the bigger the
 * words, the more room they need to sit on.
 */
export const DENSITIES = Object.freeze({
  compact: Object.freeze({ key: 'compact', scale: 0.88, margin: 44, rowPadding: 4 }),
  normal: Object.freeze({ key: 'normal', scale: 1, margin: 50, rowPadding: 6 }),
  large: Object.freeze({ key: 'large', scale: 1.12, margin: 40, rowPadding: 6 }),
})

const HEX = /^#[0-9a-f]{6}$/i
const DEFAULT_ACCENT = '#0b5394'

/** Logos are bounded so that one cannot push the issuer block off the page. */
const LOGO_SCALE = Object.freeze({ min: 0.5, max: 1.6, fallback: 1 })

/**
 * Turns a stored branding row — or nothing at all — into a complete theme.
 *
 * Every field is checked here rather than at the point it is drawn: a bad hex
 * colour reaching PDFKit throws inside a stream that has already begun, which
 * surfaces as a truncated download rather than as an error anybody can read.
 *
 * @param {object|null} row an invoice_branding row.
 * @param {object} companyDefaults the installation's COMPANY_* values.
 * @returns {object} template, density, accent, logo and issuer, all valid.
 */
export function resolveTheme(row, companyDefaults = {}) {
  const branding = row ?? {}
  const template = TEMPLATES[branding.template] ?? TEMPLATES.classique
  const density = DENSITIES[branding.density] ?? DENSITIES.normal
  const accent = HEX.test(branding.accent ?? '') ? branding.accent : DEFAULT_ACCENT
  const font = FONTS[branding.font] ?? FONTS.sans

  const scale = Number(branding.logo_scale)
  const logoScale = Number.isFinite(scale)
    ? Math.min(LOGO_SCALE.max, Math.max(LOGO_SCALE.min, scale))
    : LOGO_SCALE.fallback

  return {
    template,
    density,
    accent,
    font,
    logo: branding.logo_data
      ? { data: branding.logo_data, mime: branding.logo_mime, scale: logoScale }
      : null,
    // A blank field means "use the installation's", not "print nothing" — so
    // an empty telephone box does not silently erase the number on a bill.
    issuer: {
      name: pick(branding.company_name, companyDefaults.name),
      ice: pick(branding.company_ice, companyDefaults.ice),
      address: pick(branding.company_address, companyDefaults.address),
      email: pick(branding.company_email, companyDefaults.email),
      phone: pick(branding.company_phone, companyDefaults.phone),
    },
    footerNote: (branding.footer_note ?? '').trim(),
  }
}

const pick = (value, fallback) => {
  const clean = typeof value === 'string' ? value.trim() : ''
  return clean || (fallback ?? '')
}

/** @returns {boolean} whether a template key is one we draw. */
export const isTemplate = (key) => Object.hasOwn(TEMPLATES, key)
/** @returns {boolean} whether a density key is one we draw. */
export const isDensity = (key) => Object.hasOwn(DENSITIES, key)
/** @returns {boolean} whether a colour is a six-digit hex. */
export const isAccent = (value) => HEX.test(value ?? '')
/** @returns {boolean} whether a typeface key is one we can draw with. */
export const isFont = (key) => Object.hasOwn(FONTS, key)
