import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestContainer } from './helpers.js'
import { significantTerms } from '../src/analytics/terms.js'

const BUYER = 'CENTRE HOSPITALIER PROVINCIAL DE KHENIFRA'

/** Inserts an award straight into the store; no scraping involved. */
async function award(container, index, fields) {
  await container.repositories.results.upsert({
    result_key: `key-${index}`,
    reference: fields.reference ?? `${index}/2026`,
    reference_raw: fields.reference ?? `${index}/2026`,
    match_key: `${index}/2026|x`,
    objet: fields.objet,
    acheteur: fields.acheteur ?? BUYER,
    attributaire: fields.attributaire ?? 'STE EXEMPLE',
    montant_attribue_cents: fields.cents ?? 100000,
    currency: 'MAD',
    nombre_offres: fields.bids ?? 8,
    result_status: fields.status ?? 'attribue',
    date_publication_resultat: fields.on ?? '2026-08-01',
    first_seen_at: '2026-08-01T00:00:00.000Z',
    last_seen_at: '2026-08-01T00:00:00.000Z',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    search_text: `${fields.reference ?? index} ${fields.objet} ${fields.acheteur ?? BUYER}`.toLowerCase(),
  })
}

async function consultation(container, fields) {
  const { row } = await container.repositories.consultations.upsert({
    source_id: fields.sourceId,
    reference: fields.reference,
    reference_raw: fields.reference,
    match_key: `${fields.reference}|y`,
    objet: fields.objet,
    acheteur: fields.acheteur ?? BUYER,
    date_publication: '2026-09-01',
    date_limite: '2026-10-01',
    status: 'open',
    first_seen_at: '2026-09-01T00:00:00.000Z',
    last_seen_at: '2026-09-01T00:00:00.000Z',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    search_text: `${fields.reference} ${fields.objet} ${fields.acheteur ?? BUYER}`.toLowerCase(),
  })
  return row
}

test('the buyer’s own name never becomes a term for comparing work', () => {
  // "Achat de pièces de rechange pour le centre hospitalier provincial de
  // Khénifra" — the longest words in that sentence name the buyer, so without
  // excluding them the comparable set collapses into everything that one
  // hospital has ever bought.
  const objet = 'Achat des pièces de rechanges pour le centre hospitalier provincial de khénifra'
  assert.deepEqual(significantTerms(objet, { exclude: BUYER }), ['rechanges', 'pieces'])
  assert.ok(significantTerms(objet).includes('hospitalier'), 'and they would otherwise win the ranking')
})

test('the price benchmark answers from comparable work, not from the same buyer', async (t) => {
  const container = await createTestContainer()
  t.after(() => container.db.close?.())

  // Six spare-part purchases, and one unrelated purchase by the same buyer.
  for (const [index, cents] of [[1, 100000], [2, 200000], [3, 300000], [4, 400000], [5, 500000], [6, 600000]]) {
    await award(container, index, { objet: `Achat de pièces de rechanges lot ${index}`, cents, bids: index + 4 })
  }
  await award(container, 7, { objet: 'Location d’un véhicule de service', cents: 9_900_000 })
  await award(container, 8, { objet: 'Achat de pièces de rechanges lot 8', status: 'infructueux', cents: 0 })

  const avis = await consultation(container, {
    sourceId: '1', reference: '99/2026', objet: 'Achat des pièces de rechanges pour le centre hospitalier provincial de khénifra',
  })
  const benchmark = await container.services.analytics.benchmark(avis)

  assert.deepEqual(benchmark.terms, ['rechanges', 'pieces'])
  assert.equal(benchmark.awarded, 6, 'six priced comparables')
  assert.equal(benchmark.enough, true)
  // Nearest-rank median of 1000..6000 is the 3rd value; the unrelated 99,000
  // vehicle hire by the same buyer is not in the sample at all.
  assert.equal(benchmark.median, 3000)
  assert.equal(benchmark.low, 2000)
  assert.equal(benchmark.high, 5000)
  assert.ok(!benchmark.examples.some((row) => /véhicule/.test(row.objet)), 'same buyer is not the same work')

  // One in seven of the comparable avis ended with nobody awarded, and saying so
  // is half the answer to "what should I quote".
  assert.equal(benchmark.unsuccessfulRate, 14.3)
})

test('a thin sample reports that it cannot say, rather than quoting a median of two', async (t) => {
  const container = await createTestContainer()
  t.after(() => container.db.close?.())
  await award(container, 1, { objet: 'Achat de pièces de rechanges lot 1' })

  const avis = await consultation(container, { sourceId: '1', reference: '99/2026', objet: 'Achat des pièces de rechanges' })
  const benchmark = await container.services.analytics.benchmark(avis)

  assert.equal(benchmark.awarded, 1)
  assert.equal(benchmark.enough, false, 'one comparable is not a price')
})

test('a purchase this buyer already published is shown as precedent, not linked as its award', async (t) => {
  const container = await createTestContainer()
  t.after(() => container.db.close?.())

  // The shape the live data actually has: identical buyer, word-for-word
  // identical objet, and a reference that disagrees — always lower on the award.
  await award(container, 20, {
    reference: '20/2026', objet: 'achat de produits de nettoyage', status: 'infructueux', cents: 0, on: '2026-09-04',
  })
  const avis = await consultation(container, {
    sourceId: '1', reference: '23/2026', objet: 'achat de produits de nettoyage',
  })

  const precedents = await container.services.analytics.precedents(avis)
  assert.equal(precedents.length, 1)
  assert.equal(precedents[0].reference, '20/2026')
  assert.equal(precedents[0].result_status, 'infructueux')

  // And it stays unlinked: asserting this avis was already awarded would be
  // false, which is exactly what a fuzzy matcher would have claimed.
  await container.runner.matcher.run()
  const fresh = await container.repositories.consultations.findById(avis.id)
  assert.equal(fresh.status, 'open')
  assert.equal(await container.services.consultations.getResultForConsultation(avis.id).catch(() => null), null)
})

test('a buyer profile counts what they publish, and how often they withdraw it', async (t) => {
  const container = await createTestContainer()
  t.after(() => container.db.close?.())

  for (const index of [1, 2, 3, 4]) {
    await consultation(container, { sourceId: String(index), reference: `${index}/2026`, objet: `Achat lot ${index}` })
  }
  const withdrawn = await container.repositories.consultations.findBySourceId('4')
  await container.repositories.consultations.update(withdrawn.id, { status: 'annule', is_cancelled: 1 })
  await award(container, 9, { objet: 'Achat lot 1', cents: 500000, bids: 11 })

  const profile = await container.services.analytics.buyer(BUYER, container.services.consultations)

  assert.equal(profile.avis.total, 4)
  assert.equal(profile.avis.cancelled, 1)
  assert.equal(profile.cancellationRate, 25, 'a rate, because 1 of 4 and 1 of 400 are different buyers')
  assert.equal(profile.awards.total, 1)
  assert.equal(profile.awards.avgBids, 11)
  assert.ok(profile.winners.length >= 1)
  assert.equal(profile.recentAvis.length, 4)
})

test('a median over a filtered slice binds its own parameters', async (t) => {
  const container = await createTestContainer()
  t.after(() => container.db.close?.())

  // Two buyers, deliberately different price levels. Until the fix, the WHERE
  // clause's parameters were not bound and the LIMIT took their place, so any
  // median over a filtered slice came back as 0/0 — NaN on the page.
  for (const [index, cents] of [[1, 100000], [2, 300000], [3, 500000]]) {
    await award(container, index, { objet: `Achat lot ${index}`, cents })
  }
  for (const [index, cents] of [[4, 8_000_000], [5, 9_000_000]]) {
    await award(container, index, { objet: `Achat lot ${index}`, cents, acheteur: 'AUTRE ACHETEUR' })
  }
  await consultation(container, { sourceId: '1', reference: '1/2026', objet: 'Achat lot 1' })

  const profile = await container.services.analytics.buyer(BUYER, container.services.consultations)
  assert.equal(profile.awards.median, 3000, 'the middle of 1000, 3000, 5000 — not the other buyer’s')

  const filtered = await container.services.analytics.overview({ acheteur: 'AUTRE ACHETEUR' })
  // An even count averages the two middle values: (80000 + 90000) / 2.
  assert.equal(filtered.summary.median, 85000, 'and the same holds for a filtered overview')

  const everything = await container.services.analytics.overview({})
  assert.equal(everything.summary.median, 5000, 'the unfiltered median still works')
})

test('a user with no saved search is offered one that needs no filters', async (t) => {
  const container = await createTestContainer()
  t.after(() => container.db.close?.())
  const user = await container.services.auth.register({
    email: 'u@test.ma', password: 'a-very-long-password', role: 'user',
  })

  // The offer on screen posts exactly this, and it has to be accepted: a
  // filterless search is the digest, and it runs through the same pipeline as
  // any other rather than a second code path that nothing has ever tested.
  const userId = user.user?.id ?? user.id
  await container.services.savedSearches.create(userId, {
    name: 'Every new avis', filters: {}, notifyNew: true, notifyAwards: false,
  })

  const [saved] = await container.services.savedSearches.list(userId)
  assert.deepEqual(saved.filters, {}, 'no filters at all is a valid alert')
  assert.equal(saved.notify_new, true)
})

test('a two-word search finds rows whose words are not adjacent, and ranks them', async (t) => {
  const container = await createTestContainer()
  t.after(() => container.db.close?.())

  const rows = [
    ['1/2026', 'Achat de produits de nettoyage et d’entretien'],   // both words, not adjacent
    ['2/2026', 'Fourniture de produits alimentaires'],              // one word only
    ['3/2026', 'produits nettoyage'],                               // the exact phrase
    ['4/2026', 'Travaux de peinture'],                              // neither
  ]
  for (const [reference, objet] of rows) {
    await consultation(container, { sourceId: reference, reference, objet })
  }

  // Every term must match, so the alimentaires row and the peinture row are out
  // — the old single-substring LIKE found none of these at all.
  const found = await container.services.consultations.search(
    { q: 'produits nettoyage' }, { limit: 10, offset: 0, sort: 'relevance' },
  )
  assert.deepEqual(found.data.map((row) => row.reference), ['3/2026', '1/2026'])

  // Accents are folded the way the scraper folded them when it wrote search_text.
  const accented = await container.services.consultations.search(
    { q: 'ENTRETIEN' }, { limit: 10, offset: 0 },
  )
  assert.deepEqual(accented.data.map((row) => row.reference), ['1/2026'])

  // Relevance asked for with nothing to be relevant to falls back to the
  // default order rather than returning rows in an arbitrary one.
  const unranked = await container.services.consultations.search(
    {}, { limit: 10, offset: 0, sort: 'relevance' },
  )
  assert.equal(unranked.data.length, 4)
})

test('a company profile answers what they win and from whom', async (t) => {
  const container = await createTestContainer()
  t.after(() => container.db.close?.())

  await award(container, 1, { objet: 'Achat A', cents: 100000, bids: 6 })
  await award(container, 2, { objet: 'Achat B', cents: 300000, bids: 10 })
  await award(container, 3, { objet: 'Achat C', cents: 500000, acheteur: 'AUTRE ACHETEUR' })
  await award(container, 4, { objet: 'Achat D', cents: 900000, attributaire: 'CONCURRENT SARL' })

  const profile = await container.services.analytics.company('STE EXEMPLE', container.services.consultations)

  assert.equal(profile.awards, 3, 'only what they won')
  assert.equal(profile.buyers, 2, 'across two buyers')
  assert.equal(profile.median, 3000)
  assert.equal(profile.min, 1000)
  assert.equal(profile.max, 5000)
  assert.equal(profile.totalAmount, 9000)
  assert.ok(profile.topBuyers.some((row) => row.label === BUYER))
  assert.ok(!profile.recentAwards.some((row) => row.attributaire === 'CONCURRENT SARL'))
})
