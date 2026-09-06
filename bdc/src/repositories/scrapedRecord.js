import crypto from 'node:crypto'

/**
 * Merge and change-detection rules shared by the scraped tables.
 *
 * The same row is seen through two lenses: the listing page (a handful of
 * columns) and the detail page (everything). A naive overwrite would let the
 * next listing pass wipe the estimation, lots and qualification that the detail
 * pass just stored — and the row would then flip between the two shapes on every
 * crawl. So a scraped value only ever *adds* information: null never overwrites
 * a value already on record.
 */

/** Columns whose change makes a row genuinely "updated". */
export const CONSULTATION_HASH_COLUMNS = [
  'objet', 'acheteur', 'categorie', 'nature_prestation', 'lieu_execution', 'procedure_type',
  'mode_passation', 'date_publication', 'date_limite', 'heure_limite', 'estimation_cents',
  'caution_provisoire_cents', 'qualification', 'agrement',
]

export const RESULT_HASH_COLUMNS = [
  'objet', 'acheteur', 'categorie', 'nature_prestation', 'lieu_execution',
  'date_publication_resultat', 'date_attribution', 'attributaire', 'attributaire_ice',
  'montant_attribue_cents', 'nombre_offres', 'result_status',
]

/** Stable fingerprint of the significant columns of a row. */
export function hashColumns(row, columns) {
  const significant = columns.map((column) => row[column] ?? null)
  return crypto.createHash('sha1').update(JSON.stringify(significant)).digest('hex')
}

/**
 * Applies an incoming scrape onto the stored row.
 * @param {object} existing stored row.
 * @param {object} incoming freshly scraped row.
 * @param {string[]} mutableColumns columns a scrape is allowed to touch.
 * @returns {object} the merged column values (no id, no timestamps).
 */
export function mergeScraped(existing, incoming, mutableColumns) {
  const merged = {}
  for (const column of mutableColumns) {
    const value = incoming[column]
    merged[column] = value === null || value === undefined || value === '' ? existing[column] : value
  }
  return merged
}
