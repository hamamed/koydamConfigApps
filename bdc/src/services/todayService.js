/**
 * What a bidder needs on opening the panel.
 *
 * The listing has some seven hundred rows and answers "what exists". This
 * answers "what has changed since I looked, and what runs out next" — the two
 * questions that actually decide whether somebody bids in time. The window
 * between publication and closing has a median of four days and 93% of what is
 * open closes inside two, so anything older than a glance is already history.
 */

/** Anything closing inside this many hours is the urgent list. */
const CLOSING_HOURS = 48
const LIMIT = 12

export function createTodayService({ consultations, favorites, users, savedSearches }) {
  /**
   * @param {object} user the signed-in user.
   * @param {boolean} [markSeen] whether this visit moves the "last looked" mark.
   */
  async function forUser(user, { markSeen = true } = {}) {
    // Read the previous mark and move it in one step, so a reload does not show
    // the same avis as new twice while a genuine visit still advances it.
    const since = markSeen ? await users.touchPanel(user.id) : null

    const [fresh, closing, tracked, searches] = await Promise.all([
      since
        ? consultations.search({ firstSeenAfter: since }, { limit: LIMIT, offset: 0, sort: 'date_publication:desc' }, user.id)
        : Promise.resolve({ data: [], total: 0 }),
      consultations.search({ status: 'open' }, { limit: 200, offset: 0, sort: 'date_limite:asc' }, user.id),
      favorites.list(user.id, {}, { limit: 100, offset: 0 }),
      savedSearches.list(user.id),
    ])

    // Sorted by deadline ascending, so the urgent ones are the head of the list
    // — but the hour decides, not the date, and anything already shut is gone.
    const urgent = closing.data
      .filter((row) => row.deadline && row.deadline.hours > 0 && row.deadline.hours <= CLOSING_HOURS)
      .sort((a, b) => a.deadline.hours - b.deadline.hours)

    // An avis somebody follows that has since been settled: the answer to the
    // question they were watching it for.
    const settled = (tracked.data ?? []).filter((row) => row.result).slice(0, LIMIT)

    return {
      since,
      fresh: fresh.data,
      freshTotal: fresh.total,
      urgent: urgent.slice(0, LIMIT),
      urgentTotal: urgent.length,
      settled,
      tracking: (tracked.data ?? []).length,
      // A user with no saved search is told about nothing at all, which is the
      // state every new account starts in.
      needsSetup: searches.length === 0,
    }
  }

  return { forUser }
}
