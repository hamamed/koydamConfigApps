import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MARKET_KINDS,
  bandFor,
  classifyKind,
  computeReferencePrice,
} from '../src/utils/referencePrice.js'

/**
 * Article 44 of décret n° 2-22-431 as the fixtures below read it:
 *
 *   A. Le prix de référence des offres est égal à la moyenne arithmétique
 *      résultant de l'estimation du coût des prestations établie par le maître
 *      d'ouvrage et de la moyenne des offres financières des concurrents
 *      retenus.
 *   B. 1 — L'offre est jugée excessive lorsqu'elle est supérieure de plus de
 *          vingt pour cent (20%) par rapport à l'estimation […] pour les
 *          marchés de travaux, de fournitures et de services autres que ceux
 *          portant sur les études.
 *      2 — L'offre est jugée anormalement basse lorsqu'elle est inférieure de
 *          plus de vingt pour cent (20%) […] pour les marchés de travaux ; de
 *          vingt-cinq pour cent (25%) […] pour les marchés de fournitures et de
 *          services autres que ceux portant sur les études.
 */

const DH = (amount) => Math.round(amount * 100)

test('the band is symmetric for travaux and asymmetric for fournitures and services', () => {
  assert.deepEqual(bandFor(MARKET_KINDS.TRAVAUX), { lowPercent: 20, highPercent: 20 })
  assert.deepEqual(bandFor(MARKET_KINDS.FOURNITURES), { lowPercent: 25, highPercent: 20 })
  assert.deepEqual(bandFor(MARKET_KINDS.SERVICES), { lowPercent: 25, highPercent: 20 })
})

test('études carry no band, because article 44 excludes them', () => {
  assert.equal(bandFor(MARKET_KINDS.ETUDES), null)
})

test('classifyKind reads the nature the portal prints', () => {
  assert.equal(classifyKind('Travaux'), MARKET_KINDS.TRAVAUX)
  assert.equal(classifyKind('FOURNITURES'), MARKET_KINDS.FOURNITURES)
  assert.equal(classifyKind('Services'), MARKET_KINDS.SERVICES)
  // Études are a kind of service, so the more specific word has to win.
  assert.equal(classifyKind('Services — études techniques'), MARKET_KINDS.ETUDES)
  assert.equal(classifyKind(''), null)
  assert.equal(classifyKind(null), null)
})

test('the reference price is the mean of the estimate and the mean of retained offers', () => {
  // Estimate 100 000; offers 90 000 and 110 000 are both inside [80 000, 120 000].
  // mean(offers) = 100 000 → P = (100 000 + 100 000) / 2 = 100 000.
  const result = computeReferencePrice({
    estimateCentimes: DH(100_000),
    kind: MARKET_KINDS.TRAVAUX,
    offers: [
      { name: 'A', amountCentimes: DH(90_000) },
      { name: 'B', amountCentimes: DH(110_000) },
    ],
  })

  assert.equal(result.retainedCount, 2)
  assert.equal(result.meanRetainedCentimes, DH(100_000))
  assert.equal(result.referenceCentimes, DH(100_000))
})

test('an offer more than 20% under the estimate is anormalement basse on travaux', () => {
  const result = computeReferencePrice({
    estimateCentimes: DH(1_000_000),
    kind: MARKET_KINDS.TRAVAUX,
    offers: [
      { name: 'Too low', amountCentimes: DH(799_999) },
      { name: 'Exactly at the bound', amountCentimes: DH(800_000) },
      { name: 'Fine', amountCentimes: DH(950_000) },
    ],
  })

  const status = Object.fromEntries(result.offers.map((o) => [o.name, o.status]))
  // "inférieure de plus de vingt pour cent" — exactly -20% is not *more* than
  // 20% under, so the offer sitting on the bound is retained.
  assert.equal(status['Too low'], 'abnormally_low')
  assert.equal(status['Exactly at the bound'], 'retained')
  assert.equal(status.Fine, 'retained')
  assert.equal(result.retainedCount, 2)
})

test('the low bound is 25% on fournitures but the high bound stays at 20%', () => {
  const result = computeReferencePrice({
    estimateCentimes: DH(1_000_000),
    kind: MARKET_KINDS.FOURNITURES,
    offers: [
      { name: 'Deep', amountCentimes: DH(760_000) }, // -24%: retained here, excluded on travaux
      { name: 'High', amountCentimes: DH(1_240_000) }, // +24%: excessive, the band is not ±25%
    ],
  })

  const status = Object.fromEntries(result.offers.map((o) => [o.name, o.status]))
  assert.equal(status.Deep, 'retained')
  assert.equal(status.High, 'excessive')
})

test('excluded offers do not move the reference price', () => {
  const withOutlier = computeReferencePrice({
    estimateCentimes: DH(1_000_000),
    kind: MARKET_KINDS.TRAVAUX,
    offers: [
      { name: 'A', amountCentimes: DH(900_000) },
      { name: 'B', amountCentimes: DH(1_000_000) },
      { name: 'Excessive', amountCentimes: DH(5_000_000) },
    ],
  })
  const without = computeReferencePrice({
    estimateCentimes: DH(1_000_000),
    kind: MARKET_KINDS.TRAVAUX,
    offers: [
      { name: 'A', amountCentimes: DH(900_000) },
      { name: 'B', amountCentimes: DH(1_000_000) },
    ],
  })

  assert.equal(withOutlier.referenceCentimes, without.referenceCentimes)
})

test('the closest offer below the reference price wins', () => {
  // Estimate 1 000 000; retained 850 000 / 1 000 000 / 1 150 000 → mean 1 000 000,
  // P = 1 000 000. 1 000 000 sits on the reference itself and takes it.
  const result = computeReferencePrice({
    estimateCentimes: DH(1_000_000),
    kind: MARKET_KINDS.TRAVAUX,
    offers: [
      { name: 'Low', amountCentimes: DH(850_000) },
      { name: 'Exact', amountCentimes: DH(1_000_000) },
      { name: 'High', amountCentimes: DH(1_150_000) },
    ],
  })

  assert.equal(result.referenceCentimes, DH(1_000_000))
  assert.equal(result.winner.name, 'Exact')
  assert.equal(result.winnerSide, 'below')
})

test('a cheaper offer loses to a dearer one that sits closer under the reference', () => {
  const result = computeReferencePrice({
    estimateCentimes: DH(1_000_000),
    kind: MARKET_KINDS.TRAVAUX,
    offers: [
      { name: 'Cheapest', amountCentimes: DH(820_000) },
      { name: 'Closest', amountCentimes: DH(940_000) },
    ],
  })

  // mean(820 000, 940 000) = 880 000 → P = (1 000 000 + 880 000) / 2 = 940 000.
  assert.equal(result.referenceCentimes, DH(940_000))
  assert.equal(result.winner.name, 'Closest')
  // This is the whole point of the rule: the lowest bid is not the winner.
  assert.notEqual(result.winner.name, 'Cheapest')
})

test('with nothing below the reference the closest above it wins', () => {
  const result = computeReferencePrice({
    estimateCentimes: DH(1_000_000),
    kind: MARKET_KINDS.TRAVAUX,
    offers: [
      { name: 'Only', amountCentimes: DH(1_100_000) },
      { name: 'Dearer', amountCentimes: DH(1_190_000) },
    ],
  })

  // mean = 1 145 000 → P = 1 072 500; both offers are above it.
  assert.equal(result.referenceCentimes, DH(1_072_500))
  assert.equal(result.winnerSide, 'above')
  assert.equal(result.winner.name, 'Only')
})

test('ranking puts every offer below the reference ahead of every offer above it', () => {
  const result = computeReferencePrice({
    estimateCentimes: DH(1_000_000),
    kind: MARKET_KINDS.TRAVAUX,
    offers: [
      { name: 'Above by a hair', amountCentimes: DH(960_000) },
      { name: 'Below by a lot', amountCentimes: DH(820_000) },
      { name: 'Below by a hair', amountCentimes: DH(940_000) },
    ],
  })

  const ranked = result.offers.filter((o) => o.rank !== null).sort((a, b) => a.rank - b.rank)
  assert.deepEqual(
    ranked.map((o) => o.name),
    ['Below by a hair', 'Below by a lot', 'Above by a hair'],
  )
})

test('no retained offer means no reference price, which is article 45 territory', () => {
  const result = computeReferencePrice({
    estimateCentimes: DH(1_000_000),
    kind: MARKET_KINDS.TRAVAUX,
    offers: [{ name: 'Way under', amountCentimes: DH(10_000) }],
  })

  assert.equal(result.retainedCount, 0)
  assert.equal(result.referenceCentimes, null)
  assert.equal(result.winner, null)
  assert.equal(result.infructueux, true)
})

test('études get no band, so nothing is excluded and no reference price is claimed', () => {
  const result = computeReferencePrice({
    estimateCentimes: DH(1_000_000),
    kind: MARKET_KINDS.ETUDES,
    offers: [{ name: 'A', amountCentimes: DH(10_000) }],
  })

  assert.equal(result.band, null)
  assert.equal(result.referenceCentimes, null)
  assert.equal(result.offers[0].status, 'retained')
})

test('percentages against the estimate are reported for every offer', () => {
  const result = computeReferencePrice({
    estimateCentimes: DH(1_000_000),
    kind: MARKET_KINDS.TRAVAUX,
    offers: [{ name: 'A', amountCentimes: DH(850_000) }],
  })

  assert.equal(result.offers[0].deltaPercent, -15)
})

test('an estimate of zero or less is rejected rather than divided by', () => {
  assert.throws(() => computeReferencePrice({ estimateCentimes: 0, kind: MARKET_KINDS.TRAVAUX, offers: [] }))
  assert.throws(() => computeReferencePrice({ estimateCentimes: null, kind: MARKET_KINDS.TRAVAUX, offers: [] }))
})

test('offers without a readable amount are dropped rather than counted as zero', () => {
  const result = computeReferencePrice({
    estimateCentimes: DH(1_000_000),
    kind: MARKET_KINDS.TRAVAUX,
    offers: [
      { name: 'Real', amountCentimes: DH(900_000) },
      { name: 'Blank', amountCentimes: null },
      { name: 'Nonsense', amountCentimes: Number.NaN },
    ],
  })

  assert.equal(result.offers.length, 1)
  assert.equal(result.retainedCount, 1)
  assert.equal(result.referenceCentimes, DH(950_000))
})
