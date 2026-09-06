import { logger } from '../utils/logger.js'
import { nowIso } from '../utils/dates.js'

const log = logger.child('[scraper:matcher]')

/**
 * Cross-references the two datasets.
 *
 * `reference` is the business key shared by both listings, normalised
 * identically on each side (see utils/text.js#normalizeReference), which is what
 * makes an exact join reliable despite the formatting noise in the source HTML.
 *
 * The matcher runs in two passes:
 *  1. Exact reference join — fills `consultation_results.consultation_id` and
 *     flips `consultations.has_result` / `status` to `awarded`.
 *  2. Housekeeping — closes consultations whose deadline has passed.
 *
 * A deliberate non-goal: fuzzy matching on `objet`. Awarding the wrong result to
 * a consultation would corrupt downstream invoices, so unmatched results simply
 * stay unmatched and are reported in the admin dashboard.
 */
export function createMatcher({ db, consultations, results }) {
  async function run() {
    const linked = await results.linkUnmatched()

    const flagged = await db.run(
      `UPDATE consultations SET has_result = 1, status = 'awarded', updated_at = ?
       WHERE has_result = 0
         AND EXISTS (SELECT 1 FROM consultation_results r WHERE r.reference = consultations.reference)`,
      [nowIso()],
    )

    const closed = await consultations.closeExpired()
    const unmatched = await results.countUnmatched()

    const stats = {
      matchesLinked: linked,
      consultationsFlagged: flagged.changes,
      consultationsClosed: closed.changes,
      unmatchedResults: unmatched,
    }
    log.info('matching pass complete', stats)
    return stats
  }

  /** Award data for one reference, used by the consultation detail endpoint. */
  async function findResultFor(reference) {
    const result = await results.findByReference(reference)
    if (!result) return null
    return { ...result, lots: await results.findLots(result.id) }
  }

  /** Results that reference a consultation this instance has never scraped. */
  const listUnmatched = (limit = 50) =>
    db.all(
      'SELECT reference, objet, acheteur, date_publication_resultat FROM consultation_results WHERE consultation_id IS NULL ORDER BY date_publication_resultat DESC LIMIT ?',
      [limit],
    )

  return { run, findResultFor, listUnmatched }
}
