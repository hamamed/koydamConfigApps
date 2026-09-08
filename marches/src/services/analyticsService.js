import { fromCentimes } from '../utils/money.js'

/**
 * What can be said about a buyer from the avis it publishes.
 *
 * This used to be a much larger service: an insights overview, a price
 * benchmark from comparable awards, the precedent for a republished purchase,
 * and a profile per winning company. All of it was computed from awards, and
 * this portal publishes none — an appel d'offres is awarded later, in a
 * separate "résultat définitif" notice that nothing here crawls yet. Those
 * screens could only ever render zeroes, so they are gone rather than
 * pretending to be empty.
 *
 * What survives is the half that reads consultations, which do exist: how much
 * a buyer publishes and how much of it it cancels.
 */
export function createAnalyticsService({ analytics }) {
  /**
   * One buyer's record.
   * @param {string} name the buyer exactly as the portal prints it — the only
   *   identifier a buyer has anywhere in its markup.
   * @param {object} listings the consultation service, for the recent avis.
   */
  async function buyer(name, listings) {
    const filters = { acheteur: name }
    const [profile, recentAvis] = await Promise.all([
      analytics.buyerProfile(name),
      listings.search(filters, { limit: 10, offset: 0, sort: 'date_publication:desc' }),
    ])

    return {
      name,
      avis: profile.avis,
      // Expressed as a rate as well as a count: "12 cancelled" means nothing
      // without knowing whether it is out of 20 or out of 2,000.
      cancellationRate:
        profile.avis.total > 0 ? Math.round((profile.avis.cancelled / profile.avis.total) * 1000) / 10 : null,
      recentAvis: recentAvis.data,
    }
  }

  return { buyer }
}

/** Centimes to a decimal amount, or null. */
export const amount = (centimes) => (centimes === null || centimes === undefined ? null : fromCentimes(centimes))
