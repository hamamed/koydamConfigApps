import { fromCentimes } from '../utils/money.js'
import { deadlineStatus } from '../utils/deadline.js'

/**
 * Internal-only columns that never leave the API.
 *
 * `match_key` and `result_key` are join plumbing — derived keys with no meaning
 * to a client, which would only invite someone to rely on their shape. The
 * portal's `source_id` does leave, because it is a real, citable identifier.
 */
const HIDDEN = new Set(['raw_json', 'search_text', 'content_hash', 'password_hash', 'match_key', 'result_key'])

/**
 * Converts a DB row into an API payload: `*_cents` integers become decimal
 * amounts under a friendlier name, 0/1 flags become booleans, internals are
 * dropped.
 */
export function serializeRow(row, { keepRaw = false } = {}) {
  if (!row) return null
  const output = {}
  for (const [column, value] of Object.entries(row)) {
    if (HIDDEN.has(column) && !keepRaw) continue
    if (column.endsWith('_cents')) {
      output[column.replace(/_cents$/, '')] = fromCentimes(value)
      continue
    }
    output[column] = value
  }
  if ('has_result' in output) output.has_result = Boolean(output.has_result)
  if ('is_cancelled' in output) output.is_cancelled = Boolean(output.is_cancelled)
  // How long is left to bid — the most useful thing to show next to a project.
  if ('date_limite' in output) output.deadline = deadlineStatus(output.date_limite)
  if ('is_active' in output) output.is_active = Boolean(output.is_active)
  if (keepRaw && row.raw_json) output.raw = safeParse(row.raw_json)
  return output
}

export const serializeRows = (rows, options) => rows.map((row) => serializeRow(row, options))

/** Consultation payload with its articles, documents and, when published, its award. */
export function serializeConsultation(consultation, { articles = [], documents = [], result = null, isFavorite } = {}) {
  return {
    ...serializeRow(consultation),
    articles: serializeRows(articles),
    documents: serializeRows(documents),
    result: result ? { ...serializeRow(result), lots: serializeRows(result.lots ?? []) } : null,
    ...(isFavorite === undefined ? {} : { isFavorite }),
  }
}

export function serializeInvoice(invoice) {
  return { ...serializeRow(invoice), items: serializeRows(invoice.items ?? []) }
}

function safeParse(value) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
