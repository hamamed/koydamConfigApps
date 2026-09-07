/**
 * The reference price of article 44 of décret n° 2-22-431 relatif aux marchés
 * publics (8 mars 2023).
 *
 * The rule decides who wins a public tender in Morocco, and it is not "the
 * cheapest bid". The commission first throws out every offer that sits too far
 * from the maître d'ouvrage's own estimate, averages what is left with that
 * estimate, and then awards the market to the offer sitting closest *under*
 * that average. A bidder who undercuts everyone is eliminated; a bidder who
 * lands a few percent below the reference wins.
 *
 * Article 44, verbatim in the parts that matter here:
 *
 *   A. Prix de référence — Après avoir écarté les offres jugées excessives et
 *      anormalement basses, la commission détermine le prix de référence. Le
 *      prix de référence des offres est égal à la moyenne arithmétique
 *      résultant de l'estimation du coût des prestations établie par le maître
 *      d'ouvrage et de la moyenne des offres financières des concurrents
 *      retenus. […] L'offre la mieux-disante, à proposer au maître d'ouvrage,
 *      est celle qui est la plus proche du prix de référence par défaut. En cas
 *      d'absence d'offres inférieures au prix de référence, l'offre la
 *      mieux-disante est celle qui est la plus proche par excès de ce prix.
 *
 *   B. 1 — L'offre est jugée excessive lorsqu'elle est supérieure de plus de
 *          vingt pour cent (20%) par rapport à l'estimation du coût des
 *          prestations établie par le maître d'ouvrage pour les marchés de
 *          travaux, de fournitures et de services autres que ceux portant sur
 *          les études.
 *      2 — L'offre est jugée anormalement basse lorsqu'elle est inférieure de
 *          plus de vingt pour cent (20%) par rapport à l'estimation […] pour
 *          les marchés de travaux ; de vingt-cinq pour cent (25%) par rapport à
 *          l'estimation […] pour les marchés de fournitures et de services
 *          autres que ceux portant sur les études.
 */

/** The market natures article 44 distinguishes. */
export const MARKET_KINDS = Object.freeze({
  TRAVAUX: 'travaux',
  FOURNITURES: 'fournitures',
  SERVICES: 'services',
  ETUDES: 'etudes',
})

export const OFFER_STATUS = Object.freeze({
  RETAINED: 'retained',
  ABNORMALLY_LOW: 'abnormally_low',
  EXCESSIVE: 'excessive',
})

/**
 * The tolerance band around the estimate, per market nature.
 *
 * Asymmetric on purpose, and this is the detail every other calculator gets
 * wrong: paragraph B.1 sets a single ceiling of 20% for travaux, fournitures
 * *and* services in one sentence, while B.2 sets a floor of 20% for travaux and
 * 25% for fournitures and services. A supplies market is therefore judged on
 * [-25%, +20%], not on ±25%.
 */
const BANDS = Object.freeze({
  [MARKET_KINDS.TRAVAUX]: Object.freeze({ lowPercent: 20, highPercent: 20 }),
  [MARKET_KINDS.FOURNITURES]: Object.freeze({ lowPercent: 25, highPercent: 20 }),
  [MARKET_KINDS.SERVICES]: Object.freeze({ lowPercent: 25, highPercent: 20 }),
})

/**
 * @param {string} kind one of MARKET_KINDS.
 * @returns {{lowPercent:number, highPercent:number}|null} null for études,
 *   which article 44 carves out of the whole mechanism, and for an unknown kind.
 */
export function bandFor(kind) {
  return BANDS[kind] ?? null
}

/**
 * Maps the free text the portal prints under "Nature de prestation" onto a
 * market nature.
 *
 * Études are a kind of service, so the narrower word is tested first — reading
 * "Services — études techniques" as a plain service would apply a band the
 * decree says does not apply to it.
 * @returns {string|null} a MARKET_KINDS value, or null when nothing matches.
 */
export function classifyKind(text) {
  const normalized = String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

  if (!normalized.trim()) return null
  if (/\betudes?\b/.test(normalized)) return MARKET_KINDS.ETUDES
  if (/travaux/.test(normalized)) return MARKET_KINDS.TRAVAUX
  if (/fourniture/.test(normalized)) return MARKET_KINDS.FOURNITURES
  if (/service|prestation/.test(normalized)) return MARKET_KINDS.SERVICES
  return null
}

const PERCENT = 100
/**
 * `Number(null)` is 0 and `Number('')` is 0, so a competitor row the user has
 * not filled in would otherwise be evaluated as an offer of nothing — which is
 * anormalement basse against any estimate and would drag the whole result.
 */
const readAmount = (value) => {
  if (value === null || value === undefined || value === '') return null
  const amount = Number(value)
  return Number.isFinite(amount) && amount > 0 ? amount : null
}

/**
 * Runs the article 44 evaluation over one set of financial offers.
 *
 * Every amount is integer centimes, and the band comparisons are done on scaled
 * integers rather than on a percentage of the estimate, so an offer sitting
 * exactly on the bound is retained — the decree excludes what is lower "de plus
 * de" 20%, not what is lower by 20%.
 *
 * @param {object} input
 * @param {number} input.estimateCentimes the maître d'ouvrage's estimate.
 * @param {string} input.kind one of MARKET_KINDS.
 * @param {Array<{name?:string, amountCentimes:number}>} input.offers
 * @returns {object} the evaluation: every offer with its status, delta and
 *   rank, the retained mean, the reference price and the mieux-disante offer.
 */
export function computeReferencePrice({ estimateCentimes, kind, offers = [] }) {
  const estimate = Number(estimateCentimes)
  if (!Number.isFinite(estimate) || estimate <= 0) {
    throw new RangeError('The maître d’ouvrage estimate is required and must be greater than zero.')
  }

  const band = bandFor(kind)

  // Silently dropping a blank row is what the form needs: an empty competitor
  // line is a row the user has not filled in yet, not an offer worth nothing.
  const entries = offers
    .map((offer, index) => ({
      name: String(offer?.name ?? '').trim(),
      amountCentimes: readAmount(offer?.amountCentimes),
      index,
    }))
    .filter((offer) => offer.amountCentimes !== null)

  const evaluated = entries.map((offer) => ({
    ...offer,
    status: statusOf(offer.amountCentimes, estimate, band),
    deltaPercent: round2(((offer.amountCentimes - estimate) / estimate) * PERCENT),
  }))

  const retained = evaluated.filter((offer) => offer.status === OFFER_STATUS.RETAINED)
  const sum = retained.reduce((total, offer) => total + offer.amountCentimes, 0)

  // Article 44 A. One rounding at the end rather than two: averaging the
  // offers and then averaging again would round a half-centime twice.
  const meanRetainedCentimes = retained.length > 0 ? Math.round(sum / retained.length) : null
  const referenceCentimes =
    band && retained.length > 0 ? Math.round((estimate * retained.length + sum) / (2 * retained.length)) : null

  const ranked = referenceCentimes === null ? [] : rank(retained, referenceCentimes)
  const winner = ranked[0] ?? null

  const byIndex = new Map(ranked.map((offer, position) => [offer.index, position + 1]))

  return {
    kind: kind ?? null,
    band,
    estimateCentimes: estimate,
    bounds: band
      ? {
          lowCentimes: Math.round((estimate * (PERCENT - band.lowPercent)) / PERCENT),
          highCentimes: Math.round((estimate * (PERCENT + band.highPercent)) / PERCENT),
        }
      : null,
    offers: evaluated.map((offer) => ({
      name: offer.name,
      amountCentimes: offer.amountCentimes,
      status: offer.status,
      deltaPercent: offer.deltaPercent,
      gapCentimes: referenceCentimes === null ? null : offer.amountCentimes - referenceCentimes,
      rank: byIndex.get(offer.index) ?? null,
    })),
    retainedCount: retained.length,
    excludedCount: evaluated.length - retained.length,
    meanRetainedCentimes,
    referenceCentimes,
    winner: winner
      ? { name: winner.name, amountCentimes: winner.amountCentimes, gapCentimes: winner.amountCentimes - referenceCentimes }
      : null,
    winnerSide: winner ? (winner.amountCentimes <= referenceCentimes ? 'below' : 'above') : null,
    // Article 45 d): an appel with no competitor left after the financial
    // offers are evaluated is declared infructueux.
    infructueux: Boolean(band) && evaluated.length > 0 && retained.length === 0,
  }
}

/** Article 44 B, on scaled integers so the bound itself stays inside the band. */
function statusOf(amountCentimes, estimate, band) {
  if (!band) return OFFER_STATUS.RETAINED
  const scaled = amountCentimes * PERCENT
  if (scaled < estimate * (PERCENT - band.lowPercent)) return OFFER_STATUS.ABNORMALLY_LOW
  if (scaled > estimate * (PERCENT + band.highPercent)) return OFFER_STATUS.EXCESSIVE
  return OFFER_STATUS.RETAINED
}

/**
 * Article 44 A's classement: everything at or under the reference price first,
 * closest to it leading, and only then what sits above it.
 *
 * Equal amounts keep the order they were entered in, which is the one thing the
 * decree leaves to the commission.
 */
function rank(retained, referenceCentimes) {
  const distance = (offer) => Math.abs(offer.amountCentimes - referenceCentimes)
  const side = (offer) => (offer.amountCentimes <= referenceCentimes ? 0 : 1)

  return [...retained].sort(
    (a, b) => side(a) - side(b) || distance(a) - distance(b) || a.index - b.index,
  )
}

const round2 = (value) => Math.round(value * 100) / 100
