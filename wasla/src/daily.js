/**
 * The daily puzzle: one level per calendar date, the same for every player.
 *
 * A date can be given a level in the panel. Any other date gets an automatic
 * pick — days since the epoch modulo the number of published levels — so it
 * needs no job, no storage and no clock agreement: every server and every
 * request answer the same for the same date.
 */

const DAY_MS = 86_400_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `{ date, day }` for a real calendar date written YYYY-MM-DD, else null.
 * `day` counts days since 1970-01-01.
 */
export function parseDay(value) {
  const match = typeof value === 'string' ? DATE.exec(value) : null;
  if (!match) return null;
  const [year, month, dayOfMonth] = match.slice(1).map(Number);
  const time = Date.UTC(year, month - 1, dayOfMonth);
  const back = new Date(time);
  // Date.UTC rolls 2026-02-30 over to March; a real date survives the round trip.
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== dayOfMonth) return null;
  if (year < 1970) return null;
  return { date: value, day: time / DAY_MS };
}

/** YYYY-MM-DD for a day number. */
export const dayToDate = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** Today in UTC, for the panel. The app sends its own local date. */
export const todayUtc = () => new Date().toISOString().slice(0, 10);

export function createDaily(db, repo) {
  const scheduledId = (date) => db.prepare('SELECT level_id FROM daily_levels WHERE date = ?').get(date)?.level_id ?? null;

  /** `{ levelId, source }` for a date, or null when nothing is published. */
  function forDate(date, published = repo.publishedLevelIds()) {
    const parsed = parseDay(date);
    if (!parsed || !published.length) return null;
    const chosen = scheduledId(parsed.date);
    // A scheduled level that has since been unpublished is not served.
    if (chosen && published.includes(chosen)) return { levelId: chosen, source: 'scheduled' };
    return { levelId: published[parsed.day % published.length], source: 'automatic' };
  }

  function schedule(date, levelId) {
    const parsed = parseDay(date);
    if (!parsed) return { error: 'هذا ليس تاريخاً صحيحاً.' };
    const id = Number(levelId);
    if (!repo.publishedLevelIds().includes(id)) return { error: 'لا يكون لغز اليوم إلا لغزاً منشوراً.' };
    db.prepare(`INSERT INTO daily_levels (date, level_id) VALUES (?, ?)
      ON CONFLICT(date) DO UPDATE SET level_id = excluded.level_id, created_at = datetime('now')`).run(parsed.date, id);
    return {};
  }

  function clear(date) {
    db.prepare('DELETE FROM daily_levels WHERE date = ?').run(String(date));
  }

  /** `count` days from `from`: each with its level and whether it was chosen. */
  function upcoming(from, count) {
    const start = parseDay(from);
    if (!start) return [];
    const published = repo.publishedLevelIds();
    return Array.from({ length: count }, (_, i) => {
      const date = dayToDate(start.day + i);
      const pick = forDate(date, published);
      return { date, levelId: pick?.levelId ?? null, source: pick?.source ?? null, scheduledId: scheduledId(date) };
    });
  }

  /** Scheduled dates after the listed window, so none is forgotten. */
  function scheduledAfter(date) {
    return db.prepare('SELECT date, level_id AS levelId FROM daily_levels WHERE date > ? ORDER BY date').all(date);
  }

  return { forDate, schedule, clear, upcoming, scheduledAfter };
}
