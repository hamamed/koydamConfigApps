import { clean } from './text.js'

/**
 * Monetary amounts are stored as integer centimes everywhere in this codebase.
 * Floating point currency arithmetic silently loses fractions of a dirham once
 * lot totals are summed, so every boundary converts to/from centimes instead.
 */
export const CENTIMES_PER_UNIT = 100

const CURRENCY_NOISE = /[^\d,.\s]/g
const MAX_DECIMAL_DIGITS = 2

/**
 * Parses the amount formats found on the portal ("1 234 567,89 DH",
 * "1.234.567,89", "1234567.89") into integer centimes.
 * @returns {number|null} centimes, or null when no amount can be read.
 */
export function parseAmountToCentimes(value) {
  const text = clean(value).replace(CURRENCY_NOISE, '').replace(/\s+/g, '')
  if (!text || !/\d/.test(text)) return null

  const lastComma = text.lastIndexOf(',')
  const lastDot = text.lastIndexOf('.')
  let decimalSeparator = null

  if (lastComma !== -1 && lastDot !== -1) {
    decimalSeparator = lastComma > lastDot ? ',' : '.'
  } else if (lastComma !== -1) {
    // French formatting: a lone comma is always the decimal separator.
    decimalSeparator = text.indexOf(',') === lastComma ? ',' : null
  } else if (lastDot !== -1) {
    const decimals = text.length - lastDot - 1
    decimalSeparator = text.indexOf('.') === lastDot && decimals <= MAX_DECIMAL_DIGITS ? '.' : null
  }

  const [integerPart, decimalPart = ''] = decimalSeparator
    ? [text.slice(0, text.lastIndexOf(decimalSeparator)), text.slice(text.lastIndexOf(decimalSeparator) + 1)]
    : [text, '']

  const digits = integerPart.replace(/\D/g, '')
  if (!digits) return null

  const centimes = decimalPart.padEnd(MAX_DECIMAL_DIGITS, '0').slice(0, MAX_DECIMAL_DIGITS)
  return Number(digits) * CENTIMES_PER_UNIT + Number(centimes)
}

/** Converts a decimal unit amount (12.5) into centimes (1250). */
export function toCentimes(amount) {
  if (amount === null || amount === undefined || amount === '') return null
  const parsed = typeof amount === 'number' ? amount : Number.parseFloat(String(amount).replace(',', '.'))
  if (!Number.isFinite(parsed)) return null
  return Math.round(parsed * CENTIMES_PER_UNIT)
}

/** Converts centimes back into a decimal unit amount for JSON payloads. */
export function fromCentimes(centimes) {
  if (centimes === null || centimes === undefined) return null
  return Number(centimes) / CENTIMES_PER_UNIT
}

/** Multiplies a (possibly fractional) quantity by a unit price, in centimes. */
export function lineTotalCentimes(quantity, unitPriceCentimes) {
  const qty = Number(quantity)
  const price = Number(unitPriceCentimes)
  if (!Number.isFinite(qty) || !Number.isFinite(price)) return 0
  return Math.round(qty * price)
}

/** Applies a percentage rate (20 => 20%) to a centimes amount. */
export function applyRate(baseCentimes, ratePercent) {
  const rate = Number(ratePercent)
  if (!Number.isFinite(rate)) return 0
  return Math.round((Number(baseCentimes) * rate) / 100)
}

/** Human readable amount using the fr-MA convention: "1 234 567,89 MAD". */
export function formatAmount(centimes, currency = 'MAD') {
  if (centimes === null || centimes === undefined) return ''
  const formatted = new Intl.NumberFormat('fr-MA', {
    minimumFractionDigits: MAX_DECIMAL_DIGITS,
    maximumFractionDigits: MAX_DECIMAL_DIGITS,
  }).format(fromCentimes(centimes))
  return `${formatted} ${currency}`.trim()
}

/**
 * An amount as a reader should see it: grouped, to the centime, with its unit.
 *
 * Takes a decimal amount, which is what the serialisers hand the views — they
 * turn every `*_cents` column into units on the way out. Every screen used to
 * format its own, so the same figure appeared as "36000" in one table,
 * "36 000" in the next and "36 000,00 MAD" in a third; and an amount printed
 * without its currency is a number, not a price.
 *
 * @param {number|string|null} amount decimal units, not centimes.
 * @param {string} [currency] printed after the figure.
 * @returns {string} "1 250 000,00 MAD", or an em dash when there is no amount.
 */
export function formatMoney(amount, currency = 'MAD') {
  if (amount === null || amount === undefined || amount === '') return '—'
  const value = typeof amount === 'number' ? amount : Number(amount)
  if (!Number.isFinite(value)) return '—'
  const formatted = new Intl.NumberFormat('fr-MA', {
    minimumFractionDigits: MAX_DECIMAL_DIGITS,
    maximumFractionDigits: MAX_DECIMAL_DIGITS,
  }).format(value)
  return currency ? `${formatted} ${currency}` : formatted
}

/** The same, for a figure already in centimes. */
export const formatCentimes = (centimes, currency = 'MAD') =>
  formatMoney(centimes === null || centimes === undefined ? null : fromCentimes(centimes), currency)
