/**
 * Dialect helpers shared by the SQLite and PostgreSQL drivers.
 *
 * All application SQL is written once, with `?` placeholders (SQLite style).
 * The PostgreSQL driver rewrites them to `$1..$n` on the way out, so query
 * builders never have to know which engine is active.
 */

const SINGLE_QUOTE = "'"

/**
 * Rewrites `?` placeholders into PostgreSQL `$n` placeholders, ignoring any `?`
 * that appears inside a single-quoted SQL string literal.
 */
export function toPositionalPlaceholders(sql) {
  let output = ''
  let index = 0
  let inString = false

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]
    if (char === SINGLE_QUOTE) {
      inString = !inString
      output += char
      continue
    }
    if (char === '?' && !inString) {
      index += 1
      output += `$${index}`
      continue
    }
    output += char
  }
  return output
}

/**
 * Builds a parameterised WHERE clause from `[sqlFragment, ...params]` entries.
 * Falsy entries are skipped so callers can inline conditional filters.
 */
export function buildWhere(clauses) {
  const active = clauses.filter(Boolean)
  if (active.length === 0) return { sql: '', params: [] }
  return {
    sql: ` WHERE ${active.map(([fragment]) => fragment).join(' AND ')}`,
    params: active.flatMap(([, ...params]) => params),
  }
}

/** Builds an ORDER BY clause restricted to an allow-list of sortable columns. */
export function buildOrderBy(sort, allowed, fallback) {
  const [rawColumn, rawDirection = 'desc'] = String(sort ?? '').split(':')
  const column = allowed.includes(rawColumn) ? rawColumn : fallback
  const direction = rawDirection.toLowerCase() === 'asc' ? 'ASC' : 'DESC'
  return ` ORDER BY ${column} ${direction}`
}

/** Builds an `INSERT ... RETURNING *` statement from a plain object. */
export function buildInsert(table, data) {
  const columns = Object.keys(data)
  const placeholders = columns.map(() => '?').join(', ')
  return {
    sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    params: columns.map((column) => data[column]),
  }
}

/**
 * Builds an upsert (`INSERT ... ON CONFLICT DO UPDATE`), supported natively by
 * both SQLite 3.24+ and PostgreSQL 9.5+.
 * @param {string[]} conflictColumns unique key the upsert pivots on.
 * @param {string[]} [updateColumns] columns refreshed on conflict; defaults to
 *   every supplied column except the conflict key.
 */
export function buildUpsert(table, data, conflictColumns, updateColumns) {
  const columns = Object.keys(data)
  const updatable = (updateColumns ?? columns).filter((column) => !conflictColumns.includes(column))
  const assignments = updatable.map((column) => `${column} = excluded.${column}`).join(', ')
  const conflictAction = assignments ? `DO UPDATE SET ${assignments}` : 'DO NOTHING'
  return {
    sql:
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) ` +
      `ON CONFLICT (${conflictColumns.join(', ')}) ${conflictAction} RETURNING *`,
    params: columns.map((column) => data[column]),
  }
}

/** Builds an `UPDATE ... WHERE id = ?` statement, skipping undefined fields. */
export function buildUpdate(table, data, idColumn = 'id') {
  const columns = Object.keys(data).filter((column) => data[column] !== undefined && column !== idColumn)
  if (columns.length === 0) return null
  return {
    sql: `UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE ${idColumn} = ? RETURNING *`,
    params: [...columns.map((column) => data[column]), data[idColumn]],
  }
}

/** Expands an array into an `IN (?, ?, ...)` fragment. */
export function buildIn(column, values) {
  if (!Array.isArray(values) || values.length === 0) return null
  return [`${column} IN (${values.map(() => '?').join(', ')})`, ...values]
}
