import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './helpers.js'
import { parseConsultationList, parseConsultationDetail } from '../src/scraper/parsers/consultationParser.js'
import { parseResultList } from '../src/scraper/parsers/resultParser.js'
import { matchField } from '../src/scraper/parsers/listParser.js'
import { buildSearchQuery } from '../src/scraper/selectors.js'

/**
 * Every fixture in this file is a page captured from the live portal, so these
 * tests encode the actual markup contract rather than an assumed one.
 */
const BASE = 'https://www.marchespublics.gov.ma/bdc/entreprise/consultation/'

test('maps the portal labels onto canonical fields', () => {
  assert.equal(matchField('Référence'), 'reference')
  assert.equal(matchField('Acheteur public'), 'acheteur')
  assert.equal(matchField('Catégorie principale'), 'categorie')
  assert.equal(matchField('Nature de prestation'), 'naturePrestation')
  assert.equal(matchField("Lieu d'exécution"), 'lieuExecution')
  assert.equal(matchField('Date mise en ligne'), 'datePublication')
  assert.equal(matchField('Date limite de réception des devis'), 'dateLimite')
  assert.equal(matchField('Date limite de remise des devis'), 'dateLimite')
  assert.equal(matchField('Entreprise attributaire'), 'attributaire')
  assert.equal(matchField('Montant TTC'), 'montantAttribue')
  assert.equal(matchField('Nombre de devis reçus'), 'nombreOffres')
  assert.equal(matchField('Unité de mesure'), 'unit')
  assert.equal(matchField('Colonne inconnue'), null)
})

test('a value that quotes its own field name is not a label', () => {
  // The cancellation motive on a real avis contains "date limite". Reading that
  // sentence as a label made the parser store the following block as the
  // deadline; labels lead with their name and are short.
  assert.equal(matchField('changement de la date limite pour la réception des devis'), null)
  assert.equal(matchField('Date limite de réception des devis'), 'dateLimite')
})

test('parses the open consultations listing', () => {
  const { items, totalPages } = parseConsultationList(fixture('live-consultations.html'), BASE)

  assert.equal(items.length, 10, 'the portal renders ten cards to a page')
  assert.equal(totalPages, 76)

  const [first] = items
  assert.equal(first.reference, '6/2026')
  assert.equal(first.objet, "TRAVAUX D'INSTALLATION D'UN ABRIS A LA STATION DU TAXIS")
  assert.equal(first.acheteur, 'Commune IZEMMOUREN')
  assert.equal(first.lieu_execution, 'AL HOCEIMA')
  assert.equal(first.date_limite, '2027-03-16')
  assert.equal(first.heure_limite, '14:00')
  assert.equal(first.is_cancelled, 1, 'the card carries an "Annulé" badge')
  assert.equal(first.status, undefined, 'the lifecycle status is derived, not scraped')
  assert.match(first.detail_url, /\/consultation\/show\/316430$/)
  assert.equal(first.source_id, '316430')

  // Category, nature and publication date are not on the card — only on the
  // detail page. The listing pass must leave them null rather than invent them.
  assert.equal(first.categorie, null)
  assert.equal(first.nature_prestation, null)
  assert.equal(first.date_publication, null)

  assert.ok(items.every((item) => item.reference && item.objet && item.acheteur))
})

test('parses a consultation detail page and its articles', () => {
  const { consultation, articles } = parseConsultationDetail(
    fixture('live-consultation-detail.html'),
    `${BASE}show/375169`,
  )

  // The reference lives only in the document title on this page.
  assert.equal(consultation.reference, '53/2026')
  assert.equal(consultation.acheteur, 'CENTRE HOSPITALIER PROVINCIAL DE KHENIFRA')
  assert.equal(consultation.categorie, 'Fournitures')
  assert.equal(consultation.nature_prestation, 'Achat de pièces de rechange pour matériel technique et informatique')
  assert.equal(consultation.lieu_execution, 'MAROC, KHENIFRA')
  assert.equal(consultation.date_publication, '2026-08-31')
  assert.equal(consultation.date_limite, '2026-10-02')
  assert.equal(consultation.heure_limite, '15:00')

  // Cancellation is a real state here: an avis can be published then withdrawn.
  assert.equal(consultation.is_cancelled, 1)
  assert.equal(consultation.date_annulation, '2026-09-01')
  assert.match(consultation.motif_annulation, /changement de la date limite/)

  assert.equal(articles.length, 19)
  assert.equal(consultation.lots_count, 19)

  const [article] = articles
  assert.equal(article.article_number, '01')
  assert.equal(article.designation, 'CÂBLE PNI avec brassard')
  assert.equal(article.quantity, 25)
  assert.equal(article.unit, 'unité')
  assert.equal(article.tva_rate, 20)
  assert.match(article.description, /moniteur multiparam/)
  assert.equal(article.consultation_reference, '53/2026')

  // These are calls for quotes: the supplier proposes the price, so the portal
  // publishes no unit price. The invoice generator is where one is supplied.
  assert.equal(article.unit_price_cents, null)
  assert.ok(articles.every((row) => row.designation && row.quantity !== null))
})

test('parses the results listing, which is complete without a detail page', () => {
  const { items } = parseResultList(fixture('live-results.html'), `${BASE}resultat`)

  assert.equal(items.length, 10)
  const [first] = items
  assert.equal(first.reference, '32/2026')
  assert.equal(first.attributaire, "STE AMALIA DES ETOILES D'OR")
  assert.equal(first.montant_attribue_cents, 806_400, '8 064,00 MAD in centimes')
  assert.equal(first.nombre_offres, 12)
  assert.equal(first.date_publication_resultat, '2026-09-05')
  assert.equal(first.result_status, 'attribue')

  assert.equal(items[1].reference, '34/2026/BG')
  assert.equal(items[1].montant_attribue_cents, 3_919_200)
  assert.ok(items.every((item) => item.reference))

  // An unsuccessful avis has no winner and no amount, and says so in the award
  // panel rather than in a labelled field.
  const unsuccessful = items.find((item) => item.reference === '37/2026')
  assert.equal(unsuccessful.result_status, 'infructueux')
  assert.equal(unsuccessful.attributaire, null)
  assert.equal(unsuccessful.montant_attribue_cents, null)
  assert.equal(unsuccessful.nombre_offres, 25)
})

test('both parsers normalise a reference to the same join key', () => {
  const consultations = parseConsultationList(fixture('live-consultations.html'), BASE).items
  const results = parseResultList(fixture('live-results-matching.html'), `${BASE}resultat`).items

  const consultation = consultations.find((item) => item.reference === '53/2026')
  const award = results.find((item) => item.reference === '53/2026')
  assert.ok(consultation && award, 'the shared reference is what links the two datasets')
  assert.equal(consultation.reference, award.reference)
})

test('an exhausted listing yields no rows', () => {
  const { items } = parseConsultationList(fixture('live-consultations-empty.html'), BASE)
  assert.equal(items.length, 0)
})

test('builds the portal search query string', () => {
  const query = buildSearchQuery(
    { reference: 'AOO 12/2026', acheteur: 'ANCFCC', categorie: 'Fournitures', datePublicationStart: '2026-01-01' },
    { page: 3, pageSize: 20 },
  )
  assert.equal(query.get('search_consultation_resultats[reference]'), 'AOO 12/2026')
  assert.equal(query.get('search_consultation_resultats[acheteur]'), 'ANCFCC')
  assert.equal(query.get('search_consultation_resultats[categorie]'), 'Fournitures')
  assert.equal(query.get('search_consultation_resultats[datePublicationStart]'), '2026-01-01')
  assert.equal(query.get('page'), '3')
  assert.equal(query.get('search_consultation_resultats[objet]'), null)
})
