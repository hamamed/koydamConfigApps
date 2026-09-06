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

export const LIST_CONTAINERS = ['.entreprise__card', 'table.table-results', 'table']

/**
 * A listing row. The portal renders both listings — open consultations and
 * results — as the same Bootstrap card, not as a table.
 */
export const ROW_SELECTORS = ['.entreprise__card']

/** The label/value blocks of a detail page ("Acheteur public" over its value). */
export const DETAIL_FIELD_SELECTORS = ['.content__icons .col-lg-3', '.content__icons > div']

/** One article on a detail page: an accordion item with a heading and a panel. */
export const ARTICLE_ITEM_SELECTORS = ['.accordion-item']
export const ARTICLE_HEADING_SELECTORS = ['.accordion-header', 'h2']
export const ARTICLE_SPEC_SELECTORS = ['.accordion-body .text-gray', '.accordion-body']
export const ARTICLE_ATTRIBUTE_SELECTORS = ['.content__article__miniCard > div', '.content__article__miniCard']

export const DETAIL_LINK_SELECTORS = ['a[href*="/consultation/show/"]', 'a[href*="/consultation/"]', 'a[href]']

export const PAGINATION_SELECTORS = ['.pagination .page-link', '.page-item a', 'a[href*="page="]']

/** Status pill printed on a card or a detail header ("Annulé"). */
export const STATUS_BADGE_SELECTORS = ['.badge', '.entreprise__card .badge']

/**
 * The award panel of a result card. Its state is not always a labelled field —
 * an unsuccessful avis simply prints "Avis d'achat infructueux" here — so the
 * panel's text is scanned for the state. Scanning the whole card instead would
 * misread an objet that happens to mention an annulment.
 */
export const RESULT_STATE_SELECTORS = ['.entreprise__rightSubCard', '.entreprise__rightSubCard--top']

export const FIELD_SYNONYMS = Object.freeze({
  reference: ['reference'],
  objet: ['objet', 'intitule'],
  acheteur: ['acheteur public', 'acheteur', 'organisme'],
  categorie: ['categorie principale', 'categorie'],
  naturePrestation: ['nature de prestation', 'nature de la prestation', 'nature'],
  lieuExecution: ["lieu d execution", 'lieu de livraison', 'localisation'],
  // "Date mise en ligne" is the portal's wording for publication, and it carries
  // a time ("31/08/2026 15:51").
  datePublication: ['date mise en ligne', 'date de mise en ligne', 'date de publication'],
  // The listing says "remise des devis", the detail page "reception des devis".
  dateLimite: [
    'date limite de reception des devis',
    'date limite de remise des devis',
    'date limite de reception',
    'date limite',
  ],
  estimation: ['estimation', 'montant estime'],
  cautionProvisoire: ['caution provisoire', 'cautionnement provisoire'],
  qualification: ['qualification'],
  agrement: ['agrement'],
  // Cancellations are a first-class state here: an avis can be published and
  // then withdrawn, and the reason is printed on the detail page.
  dateAnnulation: ["date d annulation"],
  motifAnnulation: ['reference annulation motif', 'motif'],

  // Results-only fields
  datePublicationResultat: ['date de publication du resultat', 'date du resultat'],
  dateAttribution: ["date d attribution", 'attribue le'],
  attributaire: ['entreprise attributaire', 'attributaire', 'titulaire', 'adjudicataire'],
  attributaireIce: ['ice'],
  montantAttribue: ['montant ttc', 'montant attribue', 'montant'],
  nombreOffres: ['nombre de devis recus', 'nombre de devis', "nombre d offres"],
  resultStatus: ['statut', 'etat', 'resultat'],

  // Article fields
  lotNumber: ['lot', 'numero de lot'],
  articleNumber: ['article', 'numero article'],
  designation: ['designation', 'libelle'],
  description: ['caracteristiques et specifications', 'caracteristiques', 'description'],
  quantity: ['quantite', 'qte'],
  unit: ['unite de mesure', 'unite'],
  unitPrice: ['prix unitaire'],
  tvaRate: ['tva', 'tva %'],
  garanties: ['garanties exigees', 'garanties', 'garantie'],
  delaiExecution: ["delai d execution", 'delai'],

  // Not stored — it exists so that collectSiblings stops at it instead of
  // swallowing the attachment row into the value of the field above it.
  pieceJointe: ['piece jointe', 'pieces jointes'],
})

/**
 * The portal's two search forms, as they actually are.
 *
 * Verified against the live pages, because all three of these were wrong before
 * and the filters silently did nothing:
 *
 *  - the two listings use *different* form roots. Only the results page uses
 *    `search_consultation_resultats`;
 *  - dates must be ISO `YYYY-MM-DD`. `dd/mm/yyyy` is accepted and then ignored,
 *    so a filtered crawl quietly returned the unfiltered first page;
 *  - `pageSize` must be present on every request. Without it the form binds to
 *    nothing and the page comes back with zero cards, which reads exactly like
 *    "no results" rather than "malformed query".
 *
 * `acheteur` is deliberately absent: it is an autocomplete bound to a buyer id,
 * and a name in it is ignored. Buyer filtering happens on our own rows instead.
 */
export const SEARCH_FORMS = Object.freeze({
  consultations: {
    root: 'search_consultation_entreprise',
    fields: {
      q: 'keyword',
      reference: 'reference',
      objet: 'objet',
      datePublicationStart: 'dateMiseEnLigneStart',
      datePublicationEnd: 'dateMiseEnLigneEnd',
      dateLimiteStart: 'dateLimiteStart',
      dateLimiteEnd: 'dateLimiteEnd',
    },
  },
  results: {
    root: 'search_consultation_resultats',
    fields: {
      q: 'keyword',
      reference: 'reference',
      objet: 'objet',
      // On this form the award's own publication date is `dateLimitePublication`;
      // `dateMiseEnLigne` is the date the underlying avis went online.
      datePublicationStart: 'dateLimitePublicationStart',
      datePublicationEnd: 'dateLimitePublicationEnd',
      dateMiseEnLigneStart: 'dateMiseEnLigneStart',
      dateMiseEnLigneEnd: 'dateMiseEnLigneEnd',
    },
  },
})

/** The page sizes the portal's own selector offers. Anything else is ignored. */
export const PAGE_SIZES = [10, 20, 30, 50]

export const clampPageSize = (value) =>
  PAGE_SIZES.reduce((best, size) => (Math.abs(size - value) < Math.abs(best - value) ? size : best), PAGE_SIZES[0])

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Builds the query string for one listing page.
 * @param {'consultations'|'results'} source which form to build for.
 * @param {object} filters canonical filter names (see http/filters.js).
 * @param {{page?: number, pageSize?: number}} options
 */
export function buildSearchQuery(source, filters = {}, { page = 1, pageSize = 20 } = {}) {
  const form = SEARCH_FORMS[source] ?? SEARCH_FORMS.consultations
  const params = new URLSearchParams()

  for (const [canonical, field] of Object.entries(form.fields)) {
    const value = filters[canonical]
    if (value === undefined || value === null || value === '') continue
    // A malformed date is dropped rather than sent: the portal would ignore it
    // and hand back the unfiltered listing, which looks like a successful crawl.
    if (field.startsWith('date') && !ISO_DATE.test(String(value))) continue
    params.append(`${form.root}[${field}]`, String(value))
  }

  params.append(`${form.root}[pageSize]`, String(clampPageSize(pageSize)))
  if (page > 1) params.append('page', String(page))
  return params
}
