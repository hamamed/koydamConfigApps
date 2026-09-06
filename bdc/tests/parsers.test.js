import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './helpers.js'
import { parseConsultationList, parseConsultationDetail } from '../src/scraper/parsers/consultationParser.js'
import { parseResultList, parseResultDetail } from '../src/scraper/parsers/resultParser.js'
import { matchField } from '../src/scraper/parsers/listParser.js'
import { buildSearchQuery } from '../src/scraper/selectors.js'

const LIST_URL = 'https://www.marchespublics.gov.ma/bdc/entreprise/consultation/'

test('maps French column labels onto canonical fields', () => {
  assert.equal(matchField('Référence'), 'reference')
  assert.equal(matchField("Lieu d'exécution"), 'lieuExecution')
  assert.equal(matchField('Date limite de remise des plis'), 'dateLimite')
  assert.equal(matchField('Nature de la prestation'), 'naturePrestation')
  assert.equal(matchField('Acheteur public'), 'acheteur')
  assert.equal(matchField('Colonne inconnue'), null)
})

test('parses the open consultations listing', () => {
  const { items, totalPages, totalCount } = parseConsultationList(fixture('consultations-page1.html'), LIST_URL)

  assert.equal(items.length, 2)
  assert.equal(totalPages, 2)
  assert.equal(totalCount, 248)

  const [first] = items
  assert.equal(first.reference, 'AOO12/2026')
  assert.equal(first.reference_raw, 'AOO 12/2026')
  assert.equal(first.objet, 'Acquisition de matériel informatique pour les services centraux')
  assert.equal(first.acheteur, 'Agence Nationale de la Conservation Foncière')
  assert.equal(first.categorie, 'Fournitures')
  assert.equal(first.nature_prestation, 'Achat')
  assert.equal(first.lieu_execution, 'Rabat')
  assert.equal(first.date_publication, '2026-05-12')
  assert.equal(first.date_limite, '2026-06-02')
  assert.equal(first.heure_limite, '10:30')
  assert.match(first.detail_url, /\/consultation\/detail\/884512$/)
  assert.match(first.search_text, /materiel informatique/)
})

test('parses a consultation detail page with its article/lot breakdown', () => {
  const { consultation, articles } = parseConsultationDetail(
    fixture('consultation-detail.html'),
    `${LIST_URL}detail/884512`,
    'AOO12/2026',
  )

  assert.equal(consultation.reference, 'AOO12/2026')
  assert.equal(consultation.mode_passation, "Appel d'offres ouvert")
  assert.equal(consultation.estimation_cents, 125_000_000)
  assert.equal(consultation.caution_provisoire_cents, 2_500_000)
  assert.equal(consultation.qualification, 'Secteur 5 - Classe 3')
  assert.equal(consultation.lots_count, 3)

  assert.equal(articles.length, 3)
  assert.deepEqual(
    articles.map((article) => [article.lot_number, article.quantity, article.unit_price_cents]),
    [['1', 120, 950_000], ['2', 35, 425_050], ['3', 40, 180_000]],
  )
  assert.equal(articles[0].designation, 'Ordinateurs portables 14 pouces i7')
  assert.equal(articles[0].consultation_reference, 'AOO12/2026')
  assert.equal(articles[0].delai_execution, '60 jours')
})

test('parses the results listing including unsuccessful awards', () => {
  const { items } = parseResultList(fixture('results-page1.html'), `${LIST_URL}resultat`)

  assert.equal(items.length, 2)
  const [awarded, unsuccessful] = items

  assert.equal(awarded.reference, 'AOO12/2026')
  assert.equal(awarded.attributaire, 'SOCIETE TECHNO SARL')
  assert.equal(awarded.montant_attribue_cents, 118_040_000)
  assert.equal(awarded.date_attribution, '2026-06-20')
  assert.equal(awarded.date_publication_resultat, '2026-06-25')
  assert.equal(awarded.result_status, 'attribue')

  assert.equal(unsuccessful.reference, 'MP99/2025')
  assert.equal(unsuccessful.result_status, 'infructueux')
  assert.equal(unsuccessful.attributaire, null)
})

test('the result reference matches the consultation reference exactly', () => {
  const [consultation] = parseConsultationList(fixture('consultations-page1.html'), LIST_URL).items
  const [result] = parseResultList(fixture('results-page1.html'), `${LIST_URL}resultat`).items
  assert.equal(consultation.reference, result.reference)
})

test('parses per-lot awards from a result detail page', () => {
  const { result, lots } = parseResultDetail(fixture('result-detail.html'), `${LIST_URL}resultat/detail/884512`, 'AOO12/2026')

  assert.equal(result.reference, 'AOO12/2026')
  assert.equal(result.nombre_offres, 7)
  assert.equal(lots.length, 3)
  assert.equal(lots[1].attributaire, 'BUREAUTIQUE PLUS SA')
  assert.equal(lots[1].montant_cents, 14_875_000)
  assert.equal(lots[2].lot_status, 'infructueux')
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
