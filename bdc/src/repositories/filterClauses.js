/**
 * Translates canonical filters (see http/filters.js) into parameterised SQL
 * fragments. Every value is bound, never interpolated.
 */

/** Case-insensitive "contains" that behaves the same on SQLite and PostgreSQL. */
const like = (column, value) => [`LOWER(${column}) LIKE ?`, `%${String(value).toLowerCase()}%`]

export function consultationClauses(filters = {}, alias = 'c') {
  return [
    filters.reference && [`${alias}.reference LIKE ?`, `%${filters.reference}%`],
    filters.objet && like(`${alias}.objet`, filters.objet),
    filters.categorie && like(`${alias}.categorie`, filters.categorie),
    filters.naturePrestation && like(`${alias}.nature_prestation`, filters.naturePrestation),
    filters.acheteur && like(`${alias}.acheteur`, filters.acheteur),
    filters.lieuExecution && like(`${alias}.lieu_execution`, filters.lieuExecution),
    filters.procedureType && like(`${alias}.procedure_type`, filters.procedureType),
    filters.q && [`${alias}.search_text LIKE ?`, `%${filters.q}%`],
    filters.datePublicationStart && [`${alias}.date_publication >= ?`, filters.datePublicationStart],
    filters.datePublicationEnd && [`${alias}.date_publication <= ?`, filters.datePublicationEnd],
    filters.dateLimiteStart && [`${alias}.date_limite >= ?`, filters.dateLimiteStart],
    filters.dateLimiteEnd && [`${alias}.date_limite <= ?`, filters.dateLimiteEnd],
    filters.status && [`${alias}.status = ?`, filters.status],
    filters.hasResult !== undefined && [`${alias}.has_result = ?`, filters.hasResult ? 1 : 0],
  ]
}

export function resultClauses(filters = {}, alias = 'r') {
  return [
    filters.reference && [`${alias}.reference LIKE ?`, `%${filters.reference}%`],
    filters.objet && like(`${alias}.objet`, filters.objet),
    filters.categorie && like(`${alias}.categorie`, filters.categorie),
    filters.naturePrestation && like(`${alias}.nature_prestation`, filters.naturePrestation),
    filters.acheteur && like(`${alias}.acheteur`, filters.acheteur),
    filters.lieuExecution && like(`${alias}.lieu_execution`, filters.lieuExecution),
    filters.attributaire && like(`${alias}.attributaire`, filters.attributaire),
    filters.q && [`${alias}.search_text LIKE ?`, `%${filters.q}%`],
    filters.datePublicationStart && [`${alias}.date_publication_resultat >= ?`, filters.datePublicationStart],
    filters.datePublicationEnd && [`${alias}.date_publication_resultat <= ?`, filters.datePublicationEnd],
    filters.status && [`${alias}.result_status = ?`, filters.status],
  ]
}
