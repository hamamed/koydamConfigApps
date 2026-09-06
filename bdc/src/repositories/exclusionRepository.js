import { getDb } from '../db/index.js'
import { buildInsert, buildUpdate } from '../db/sql.js'
import { nowIso } from '../utils/dates.js'
import { normalize } from '../utils/text.js'
import { buildWhere } from '../db/sql.js'
import { searchClauses } from './search.js'

const TABLE = 'company_exclusions'

/**
 * The name an exclusion is matched to an award-winning company by.
 *
 * The two sources name the same business differently — "LA SOCIETE SOUFOUH
 * ATLAS SARL" against "SOUFOUH ATLAS" — so both sides are reduced to the words
 * that carry meaning. The legal form and the "société" prefix are exactly the
 * parts that vary, and dropping them is what makes the two meet.
 */
const NOISE = /\b(la|le|les|de|du|des|et)\b|\b(ste|societe|société|ets|etablissements?|entreprise)\b|\b(sarl|s\.?a\.?r\.?l|sa|snc|scp|sas|au|s\.?a)\b/g

export function matchName(raw) {
  return normalize(raw ?? '').replace(NOISE, ' ').replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * What makes one exclusion decision distinct from another: the company, the
 * body that excluded it, when the ban started, and the trade register number
 * that tells two same-named companies apart.
 */
export const identityKey = (record) =>
  [
    matchName(record.raison_sociale),
    record.entite_publique ?? '',
    record.date_debut ?? '',
    record.registre_commerce ?? '',
  ].join('|')

export function createExclusionRepository(db = getDb()) {
  /**
   * Exclusions recorded against a company name.
   *
   * Matched on the normalised name because neither source publishes an id that
   * the other also has: an award row carries no ICE and no trade register
   * number, and an exclusion carries no portal id.
   */
  const findForCompany = (name) =>
    db.all(`SELECT * FROM ${TABLE} WHERE match_name = ? ORDER BY date_debut DESC, id DESC`, [matchName(name)])

  const listAll = (limit = 500) =>
    db.all(`SELECT * FROM ${TABLE} ORDER BY date_debut DESC, id DESC LIMIT ?`, [limit])

  /**
   * Filtered list.
   *
   * Free text matches the company, the reason and the register number together:
   * somebody looking here is as likely to be searching for "falsification" as
   * for a name, and asking them to pick a field first would be a worse screen.
   * Every term must appear, the same rule the project listings use.
   *
   * @param {{q?: string, entite?: string, statut?: 'active'|'expired'}} filters
   * @param {string} today ISO date the in-force test is made against.
   */
  function search(filters = {}, today = nowIso().slice(0, 10)) {
    const inForce = '(date_debut IS NULL OR date_debut <= ?) AND (date_fin IS NULL OR date_fin >= ?)'
    const where = buildWhere([
      ...searchClauses(filters.q, `LOWER(raison_sociale || ' ' || COALESCE(motif, '') || ' ' || COALESCE(registre_commerce, ''))`),
      filters.entite && ['entite_publique = ?', filters.entite],
      filters.statut === 'active' && [inForce, today, today],
      filters.statut === 'expired' && [`NOT (${inForce})`, today, today],
    ])
    return db.all(`SELECT * FROM ${TABLE}${where.sql} ORDER BY date_debut DESC, id DESC`, where.params)
  }

  /** The bodies that have excluded somebody, for the filter's dropdown. */
  const listEntities = async () =>
    (await db.all(
      `SELECT entite_publique AS label, COUNT(*) AS total FROM ${TABLE}
       WHERE entite_publique IS NOT NULL GROUP BY entite_publique ORDER BY entite_publique`,
    )).map((row) => ({ label: row.label, total: Number(row.total) }))

  const countAll = async () => Number((await db.get(`SELECT COUNT(*) AS total FROM ${TABLE}`)).total)

  /** Currently in force: started, and either open-ended or not yet expired. */
  const countActive = async (today = nowIso().slice(0, 10)) =>
    Number((await db.get(
      `SELECT COUNT(*) AS total FROM ${TABLE} WHERE (date_debut IS NULL OR date_debut <= ?) AND (date_fin IS NULL OR date_fin >= ?)`,
      [today, today],
    )).total)

  /**
   * @returns {Promise<{outcome: string, key: string}>} `key` is the composite
   *   the row is unique on, so a caller can tell a second row of the same run
   *   landing on an existing row from a genuine re-read of a stored one.
   */
  async function upsert(record) {
    const key = matchName(record.raison_sociale)
    const identity = identityKey(record)
    const timestamp = nowIso()
    const existing = await db.get(
      `SELECT * FROM ${TABLE}
       WHERE match_name = ? AND entite_publique IS ? AND date_debut IS ? AND registre_commerce IS ?`,
      [key, record.entite_publique ?? null, record.date_debut ?? null, record.registre_commerce ?? null],
    )

    if (!existing) {
      const { sql, params } = buildInsert(TABLE, {
        ...record,
        match_name: key,
        first_seen_at: timestamp,
        last_seen_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      })
      await db.run(sql, params)
      return { outcome: 'created', key: identity }
    }

    // Only the mutable facts. `first_seen_at` records when this instance first
    // saw the exclusion, which a re-read must never move.
    const changed = ['motif', 'date_fin', 'portee', 'document_id', 'source_url']
      .some((column) => (record[column] ?? null) !== (existing[column] ?? null))

    const { sql, params } = buildUpdate(TABLE, {
      id: existing.id,
      motif: record.motif ?? null,
      date_fin: record.date_fin ?? null,
      portee: record.portee ?? null,
      document_id: record.document_id ?? null,
      source_url: record.source_url ?? null,
      last_seen_at: timestamp,
      ...(changed ? { updated_at: timestamp } : {}),
    })
    await db.run(sql, params)
    return { outcome: changed ? 'updated' : 'unchanged', key: identity }
  }

  return { findForCompany, listAll, search, listEntities, countAll, countActive, upsert, matchName }
}
