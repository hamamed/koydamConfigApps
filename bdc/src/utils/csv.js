/**
 * CSV serialisation for the export endpoints.
 *
 * Two things this has to get right beyond quoting:
 *
 *  - **Formula injection.** A spreadsheet treats a cell beginning `=`, `+`, `-`
 *    or `@` as a formula, so scraped text starting with one of those becomes
 *    executable the moment someone opens the file. Values are prefixed with a
 *    tab, which Excel and LibreOffice both read as "this is text".
 *  - **A UTF-8 BOM.** Without it Excel on Windows reads the file as the local
 *    code page and every Arabic and accented French character is mangled — the
 *    buyer names in this data are full of both.
 */
const RISKY_PREFIX = /^[=+\-@\t\r]/

const cell = (value) => {
  if (value === null || value === undefined) return ''
  const text = String(value)
  const safe = RISKY_PREFIX.test(text) ? `\t${text}` : text
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export const CSV_BOM = '﻿'

/**
 * @param {Array<{key: string, label: string}>} columns
 * @param {object[]} rows
 * @returns {string} CSV text, BOM included.
 */
export function toCsv(columns, rows) {
  const lines = [columns.map((column) => cell(column.label)).join(',')]
  for (const row of rows) {
    lines.push(columns.map((column) => cell(row[column.key])).join(','))
  }
  return CSV_BOM + lines.join('\r\n') + '\r\n'
}

/** A filename-safe stamp, so repeated exports do not overwrite each other. */
export const exportFilename = (prefix, date = new Date()) =>
  `${prefix}-${date.toISOString().slice(0, 10)}.csv`
