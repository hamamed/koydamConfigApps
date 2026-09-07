import { getDb } from '../db/index.js'
import { buildInsert, buildOrderBy, buildUpdate, buildWhere } from '../db/sql.js'
import { SORTABLE } from '../http/filters.js'
import { nowIso } from '../utils/dates.js'

const TABLE = 'invoices'
const ITEMS_TABLE = 'invoice_items'

export function createInvoiceRepository(db = getDb()) {
  const findById = (id) => db.get(`SELECT * FROM ${TABLE} WHERE id = ?`, [id])

  const findByNumber = (invoiceNumber) =>
    db.get(`SELECT * FROM ${TABLE} WHERE invoice_number = ?`, [invoiceNumber])

  const findItems = (invoiceId) =>
    db.all(`SELECT * FROM ${ITEMS_TABLE} WHERE invoice_id = ? ORDER BY position, id`, [invoiceId])

  /**
   * Loads an invoice with its line items, and the reference of the consultation
   * it settles. The reference is not stored on the invoice — it is not an
   * identity — so it is resolved through the foreign key at read time.
   */
  async function findWithItems(id) {
    const invoice = await db.get(
      `SELECT i.*, c.reference AS consultation_reference, c.objet AS consultation_objet
       FROM ${TABLE} i LEFT JOIN consultations c ON c.id = i.consultation_id
       WHERE i.id = ?`,
      [id],
    )
    if (!invoice) return null
    return { ...invoice, items: await findItems(id) }
  }

  /** Creates the invoice and its items atomically. */
  async function create(invoice, items) {
    return db.transaction(async (tx) => {
      const { sql, params } = buildInsert(TABLE, invoice)
      const row = await tx.get(sql, params)
      const created = []
      for (const [index, item] of items.entries()) {
        const statement = buildInsert(ITEMS_TABLE, {
          ...item,
          invoice_id: row.id,
          position: item.position ?? index,
          created_at: nowIso(),
        })
        created.push(await tx.get(statement.sql, statement.params))
      }
      return { ...row, items: created }
    })
  }

  async function update(id, patch) {
    const statement = buildUpdate(TABLE, { ...patch, id, updated_at: nowIso() })
    if (!statement) return findById(id)
    return db.get(statement.sql, statement.params)
  }

  const remove = (id) => db.run(`DELETE FROM ${TABLE} WHERE id = ?`, [id])

  async function list(filters = {}, { limit, offset, sort } = {}) {
    // Qualified with the table on both sides: this joins consultations to show
    // the reference, and rewriting an unqualified clause with a regex afterwards
    // is how the favorites listing ended up throwing on an ambiguous column.
    const where = buildWhere([
      filters.userId && ['i.user_id = ?', filters.userId],
      filters.consultationId && ['i.consultation_id = ?', filters.consultationId],
      filters.status && ['i.status = ?', filters.status],
    ])
    const order = buildOrderBy(sort, SORTABLE.invoices, 'issue_date', { table: 'i' })

    const rows = await db.all(
      `SELECT i.*, c.reference AS consultation_reference
       FROM ${TABLE} i LEFT JOIN consultations c ON c.id = i.consultation_id
       ${where.sql}${order} LIMIT ? OFFSET ?`,
      [...where.params, limit, offset],
    )
    const { total } = await db.get(`SELECT COUNT(*) AS total FROM ${TABLE} i${where.sql}`, where.params)
    return { rows, total: Number(total) }
  }

  /**
   * Highest sequence number issued for a given year, used to build the next
   * invoice number. Runs inside the caller's transaction to stay race-free.
   */
  async function maxSequenceForYear(prefix, year, executor = db) {
    const row = await executor.get(
      `SELECT invoice_number FROM ${TABLE} WHERE invoice_number LIKE ? ORDER BY invoice_number DESC LIMIT 1`,
      [`${prefix}-${year}-%`],
    )
    if (!row) return 0
    return Number.parseInt(row.invoice_number.split('-').pop(), 10) || 0
  }

  const countAll = async () => Number((await db.get(`SELECT COUNT(*) AS total FROM ${TABLE}`)).total)

  return { findById, findByNumber, findItems, findWithItems, create, update, remove, list, maxSequenceForYear, countAll }
}
