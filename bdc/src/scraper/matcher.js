import { logger } from '../utils/logger.js'
import { nowIso } from '../utils/dates.js'

const log = logger.child('[scraper:matcher]')

/**
 * Cross-references the two datasets.
 *
 * A consultation is identified by the portal's own id, taken from its detail
 * URL. A reference is not an identity — each buyer numbers its own avis, so
 * "07/2026" appears three times on five pages of the live listing, once per
 * commune. Keying on it silently merged unrelated projects.
 *
 * Awards have no id at all: the results listing is a terminal card with no
 * detail page and no link. So they are linked through `match_key`, the pair
 * (reference, buyer), and the link itself is the foreign key
 * `consultation_results.consultation_id` — every join downstream is on that id.
 *
 * The matcher runs in two passes:
 *  1. Link on `match_key`, but only where exactly one consultation matches.
 *  2. Recompute each consultation's lifecycle status from the facts on record.
 *
 * Two deliberate non-goals: no fuzzy matching on `objet`, and no guessing when a
 * key is ambiguous. Attaching the wrong award to a consultation would corrupt
 * every invoice built from it, so those stay unlinked and are counted.
 */
export function createMatcher({ db, consultations, results }) {
  async function run() {
    const linked = await results.linkUnmatched()

    const flagged = await db.run(
      `UPDATE consultations SET has_result = 1, updated_at = ?
       WHERE has_result = 0
         AND EXISTS (SELECT 1 FROM consultation_results r WHERE r.consultation_id = consultations.id)`,
      [nowIso()],
    )

    const restated = await consultations.deriveStatus()
    const [unmatched, ambiguous] = await Promise.all([results.countUnmatched(), results.countAmbiguous()])

    const stats = {
      matchesLinked: linked,
      consultationsFlagged: flagged.changes,
      statusesChanged: restated,
      unmatchedResults: unmatched,
      ambiguousResults: ambiguous,
    }
    log.info('matching pass complete', stats)
    return stats
  }

  /** Award data for one consultation, used by the detail endpoint. */
  async function findResultFor(consultationId) {
    const result = await results.findForConsultation(consultationId)
    if (!result) return null
    return { ...result, lots: await results.findLots(result.id) }
  }

  /** Awards whose consultation this instance has never scraped. */
  const listUnmatched = (limit = 50) =>
    db.all(
      `SELECT reference, objet, acheteur, date_publication_resultat
       FROM consultation_results WHERE consultation_id IS NULL
       ORDER BY date_publication_resultat DESC LIMIT ?`,
      [limit],
    )

  return { run, findResultFor, listUnmatched }
}
