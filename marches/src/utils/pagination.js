export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 100

/**
 * Normalises `page` / `perPage` query parameters into safe SQL bounds.
 * Unbounded queries are the classic way to take a listing endpoint down, so the
 * page size is always clamped.
 */
export function parsePagination(query = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1)
  const requested = Number.parseInt(query.perPage ?? query.per_page ?? query.limit, 10)
  const perPage = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.isFinite(requested) ? requested : DEFAULT_PAGE_SIZE))
  return { page, perPage, limit: perPage, offset: (page - 1) * perPage }
}

/** Wraps rows in the project-wide paginated envelope. */
export function paginated(rows, total, { page, perPage }) {
  return {
    success: true,
    data: rows,
    error: null,
    meta: {
      total,
      page,
      perPage,
      totalPages: perPage > 0 ? Math.ceil(total / perPage) : 0,
      hasNextPage: page * perPage < total,
    },
  }
}

/** Wraps a single payload in the project-wide response envelope. */
export function ok(data, meta = undefined) {
  return { success: true, data, error: null, ...(meta ? { meta } : {}) }
}
