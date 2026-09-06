/**
 * Portal markup contract.
 *
 * marchespublics.gov.ma changes its DOM regularly, so nothing here relies on
 * positional selectors (`td:nth-child(3)`). Instead:
 *
 *  1. `LIST_CONTAINERS` / `ROW_SELECTORS` locate result rows with a list of
 *     candidates, tried in order until one matches.
 *  2. `FIELD_SYNONYMS` maps the *French label* printed in a table header or in a
 *     "Label : value" cell onto a canonical field name. That mapping is what
 *     actually extracts the data, so a column reorder or a class rename does not
 *     break the scraper.
 *
 * When the portal adds a label, add the synonym here — no parser change needed.
 */

export const LIST_CONTAINERS = [
  'table.table-results',
  'table#resultats',
  'table.table',
  '.consultation-list',
  '.list-consultations',
  'table',
]

export const ROW_SELECTORS = ['tbody > tr', 'tr.consultation', '.consultation-item', 'article.consultation']

export const DETAIL_LINK_SELECTORS = [
  'a[href*="/consultation/"]',
  'a[href*="detail"]',
  'a[href*="voir"]',
  'a[href]',
]

export const PAGINATION_SELECTORS = [
  '.pagination a',
  'nav.pagination a',
  'ul.pagination li a',
  'a[href*="page="]',
]

export const ARTICLE_TABLE_SELECTORS = [
  'table.table-lots',
  'table#lots',
  'table.lots',
  'table.articles',
  'table',
]

/**
 * Canonical field <- accent-free lowercase label fragments.
 * Matching is "label contains synonym", longest synonym wins.
 */
export const FIELD_SYNONYMS = Object.freeze({
  reference: ['reference', 'ref consultation', 'num consultation', 'numero de consultation', 'n consultation'],
  objet: ['objet', 'intitule', 'designation de la consultation', 'sujet'],
  acheteur: ['acheteur', 'acheteur public', 'organisme', 'maitre d ouvrage', 'entite', 'administration'],
  acheteurService: ['service', 'direction', 'entite acheteuse', 'sous ordonnateur'],
  categorie: ['categorie'],
  naturePrestation: ['nature de la prestation', 'nature prestation', 'nature'],
  lieuExecution: ["lieu d execution", 'lieu execution', 'lieu de livraison', 'lieu', 'localisation'],
  procedureType: ['type de procedure', 'procedure', 'type d annonce'],
  modePassation: ['mode de passation', 'mode'],
  datePublication: ['date de publication', 'date publication', 'publiee le', 'date de mise en ligne'],
  dateLimite: [
    'date limite de remise des plis',
    'date limite de remise',
    'date limite',
    'date de cloture',
    'cloture',
    'remise des plis',
  ],
  dateOuverturePlis: ["date d ouverture des plis", 'ouverture des plis', 'seance publique'],
  estimation: ['estimation', 'montant estime', 'budget previsionnel'],
  cautionProvisoire: ['caution provisoire', 'cautionnement provisoire'],
  qualification: ['qualification'],
  agrement: ['agrement'],
  lotsCount: ['nombre de lots', 'nb lots', 'lots'],

  // Results-only fields
  datePublicationResultat: ['date de publication du resultat', 'date du resultat', 'date de publication'],
  dateAttribution: ["date d attribution", 'attribue le', 'date de notification'],
  attributaire: ['attributaire', 'titulaire', 'adjudicataire', 'entreprise retenue', 'soumissionnaire retenu'],
  attributaireIce: ['ice', 'identifiant commun de l entreprise'],
  montantAttribue: ['montant attribue', "montant de l attribution", 'montant', 'montant ttc', 'montant marche'],
  nombreOffres: ['nombre d offres', 'nb offres', 'offres recues'],
  resultStatus: ['statut', 'etat', 'resultat'],

  // Article / lot fields
  lotNumber: ['lot', 'n lot', 'numero de lot'],
  articleNumber: ['article', 'n article', 'numero article', 'poste'],
  designation: ['designation', 'libelle', 'description de l article'],
  description: ['description', 'specifications', 'caracteristiques'],
  quantity: ['quantite', 'qte'],
  unit: ['unite', 'u'],
  unitPrice: ['prix unitaire', 'pu', 'prix'],
  delaiExecution: ["delai d execution", 'delai', 'duree'],
})

/**
 * Query-string parameter names used by the portal's Symfony search form.
 * These are also the names accepted by this API's own filter endpoints, so the
 * UI can forward its filter state unchanged.
 */
export const SEARCH_PARAM_ROOT = 'search_consultation_resultats'

export const SEARCH_PARAMS = Object.freeze({
  reference: 'reference',
  objet: 'objet',
  categorie: 'categorie',
  naturePrestation: 'naturePrestation',
  acheteur: 'acheteur',
  lieuExecution: 'lieuExecution',
  datePublicationStart: 'datePublicationStart',
  datePublicationEnd: 'datePublicationEnd',
  dateLimiteStart: 'dateLimiteStart',
  dateLimiteEnd: 'dateLimiteEnd',
})

/** Builds `search_consultation_resultats[field]=value` query pairs. */
export function buildSearchQuery(filters = {}, { page = 1, pageSize } = {}) {
  const params = new URLSearchParams()
  for (const [field, param] of Object.entries(SEARCH_PARAMS)) {
    const value = filters[field]
    if (value !== undefined && value !== null && value !== '') {
      params.append(`${SEARCH_PARAM_ROOT}[${param}]`, String(value))
    }
  }
  if (page > 1) params.append('page', String(page))
  if (pageSize) params.append('limit', String(pageSize))
  return params
}
