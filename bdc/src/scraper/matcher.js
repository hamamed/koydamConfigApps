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
 *  2. Housekeeping — recomputes every consultation's lifecycle status from the
 *     facts on record (cancelled, awarded, past its deadline, or still open).
 *
 * A deliberate non-goal: fuzzy matching on `objet`. Awarding the wrong result to
 * a consultation would corrupt downstream invoices, so unmatched results simply
 * stay unmatched and are reported in the admin dashboard.
 */
export function createMatcher({ db, consultations, results }) {
  async function run() {
    const linked = await results.linkUnmatched()

    const flagged = await db.run(
      `UPDATE consultations SET has_result = 1, updated_at = ?
       WHERE has_result = 0
         AND EXISTS (SELECT 1 FROM consultation_results r WHERE r.reference = consultations.reference)`,
      [nowIso()],
    )

    const restated = await consultations.deriveStatus()
    const unmatched = await results.countUnmatched()

    const stats = {
      matchesLinked: linked,
      consultationsFlagged: flagged.changes,
      statusesChanged: restated,
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
