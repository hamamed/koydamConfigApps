import { config } from '../config/index.js'
import { ValidationError } from '../utils/errors.js'
import { resolveTheme, isTemplate, isDensity, isAccent } from '../pdf/invoiceTheme.js'

/** PDFKit draws PNG and JPEG and nothing else, so nothing else is accepted. */
const IMAGE_TYPES = Object.freeze([
  { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
])

const MAX_LOGO_BYTES = 512 * 1024
const MAX_TEXT = 200
const MAX_NOTE = 400

/**
 * How one person's invoices look, and what they are allowed to change.
 *
 * The rules live here rather than in the view because the PDF is also produced
 * by the API and by the archiving path: a colour checked only in a form is a
 * colour that reaches PDFKit unchecked from everywhere else, and PDFKit throws
 * inside a stream that has already started sending.
 */
export function createInvoiceBrandingService({ invoiceBranding, settings }) {
  /** The installation's own issuer block, under any stored branding. */
  const companyDefaults = async () =>
    (settings ? { ...config.company, ...(await settings.section('company')) } : config.company)

  /** @returns {Promise<object>} the stored row, or null, for the form. */
  const get = (userId) => invoiceBranding.forUser(userId)

  /** @returns {Promise<object>} a complete, valid theme for this person. */
  async function themeFor(userId) {
    const [row, defaults] = await Promise.all([
      userId ? invoiceBranding.forUser(userId) : null,
      companyDefaults(),
    ])
    return resolveTheme(row, defaults)
  }

  /**
   * @param {number} userId whose branding this is.
   * @param {object} form the submitted fields.
   * @returns {Promise<object>} the row as it now stands.
   * @throws {ValidationError} on a template, density or colour we cannot draw.
   */
  async function save(userId, form) {
    const template = form.template ?? 'classique'
    const density = form.density ?? 'normal'
    const accent = (form.accent ?? '').trim() || '#0b5394'

    if (!isTemplate(template)) throw new ValidationError(`Unknown invoice template: ${template}`)
    if (!isDensity(density)) throw new ValidationError(`Unknown invoice density: ${density}`)
    if (!isAccent(accent)) throw new ValidationError('The accent colour must be a six-digit hex, like #0b5394')

    const scale = Number(form.logoScale)

    const patch = {
      template,
      density,
      accent,
      logo_scale: Number.isFinite(scale) ? Math.min(1.6, Math.max(0.5, scale)) : 1,
      company_name: text(form.companyName),
      company_ice: text(form.companyIce),
      company_address: text(form.companyAddress, MAX_NOTE),
      company_email: text(form.companyEmail),
      company_phone: text(form.companyPhone),
      footer_note: text(form.footerNote, MAX_NOTE),
    }

    // An empty file input means "leave the logo alone", never "remove it" —
    // saving the colour should not cost somebody their logo.
    const logo = readLogo(form.logo)
    if (logo) Object.assign(patch, { logo_data: logo.data, logo_mime: logo.mime })

    return invoiceBranding.save(userId, patch)
  }

  /** Removes the logo, which is the only way a logo goes away. */
  const clearLogo = (userId) => invoiceBranding.clearLogo(userId)

  return { get, save, clearLogo, themeFor }
}

/**
 * Reads an uploaded logo out of a data URL and satisfies itself that it is one.
 *
 * The declared type is not trusted: what matters is what the first bytes say,
 * because that is what PDFKit will try to decode. An SVG renamed to .png would
 * pass a filename check and then fail inside a stream that is already sending.
 *
 * @param {string} value a `data:image/png;base64,...` URL, or ''.
 * @returns {{data: string, mime: string}|null} null when nothing was uploaded.
 * @throws {ValidationError} when something was uploaded and it is not usable.
 */
function readLogo(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return null

  const match = /^data:([^;,]+);base64,(.+)$/s.exec(raw)
  if (!match) throw new ValidationError('The logo could not be read. Upload a PNG or a JPEG.')

  const buffer = Buffer.from(match[2], 'base64')
  if (buffer.length === 0) throw new ValidationError('The logo file is empty.')
  if (buffer.length > MAX_LOGO_BYTES) {
    throw new ValidationError(`The logo must be under ${Math.round(MAX_LOGO_BYTES / 1024)} KB.`)
  }

  const type = IMAGE_TYPES.find((candidate) =>
    candidate.magic.every((byte, index) => buffer[index] === byte))
  if (!type) throw new ValidationError('Only PNG and JPEG logos can be printed on a PDF.')

  return { data: buffer.toString('base64'), mime: type.mime }
}

const text = (value, max = MAX_TEXT) => {
  const clean = typeof value === 'string' ? value.trim() : ''
  return clean ? clean.slice(0, max) : null
}
