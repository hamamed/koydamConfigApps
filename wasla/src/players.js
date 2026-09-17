/**
 * The players dashboard, from the anonymous events table.
 *
 * Days are UTC calendar days of `received_at` — when the server stored the
 * event. The device clock (`at`) is not trusted for counting, and the app's
 * time zone is unknown, so a player late in the evening in Morocco counts on
 * the UTC day. A player is a distinct `device` (one install).
 */

import { HELPS } from './events.js';

const DAY_MS = 86_400_000;

export const TREND_DAYS = 30;
export const HELP_DAYS = 30;
export const RETENTION_COHORTS = 30;
export const WORD_SEARCH_DAYS = 30;

/** YYYY-MM-DD `n` days after (or before, when negative) `date`. */
export function addDays(date, n) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

const todayUtc = () => new Date().toISOString().slice(0, 10);

/**
 * The step with the largest loss along open₁ → done₁ → open₂ → done₂ …, as
 * `{ index, stage, lost }` (stage "within": opened but did not finish level
 * `index`; "between": finished level `index` but did not open the next), or
 * null when nothing drops.
 */
export function biggestDrop(rows) {
  let best = null;
  const consider = (index, stage, from, to) => {
    const lost = from - to;
    if (lost > 0 && (!best || lost > best.lost)) best = { index, stage, lost };
  };
  rows.forEach((row, i) => {
    consider(i, 'within', row.opened, row.completed);
    if (i + 1 < rows.length) consider(i, 'between', row.completed, rows[i + 1].opened);
  });
  return best;
}

export function createPlayers(db, { repo }) {
  const scalar = (sql, ...params) => db.prepare(sql).pluck().get(...params) ?? 0;

  /** Headline numbers for `today`. */
  function kpis(today = todayUtc()) {
    const tomorrow = addDays(today, 1);
    const distinctSince = (from) => scalar(
      'SELECT COUNT(DISTINCT device) FROM events WHERE received_at >= ? AND received_at < ?', from, tomorrow,
    );
    return {
      today: distinctSince(today),
      week: distinctSince(addDays(today, -6)),
      month: distinctSince(addDays(today, -29)),
      levelsCompletedToday: scalar(`SELECT COUNT(*) FROM events WHERE type = 'level_completed' AND level_number > 0
        AND received_at >= ? AND received_at < ?`, today, tomorrow),
      dailyCompletedToday: scalar(`SELECT COUNT(*) FROM events WHERE type = 'level_completed' AND level_number = 0
        AND received_at >= ? AND received_at < ?`, today, tomorrow),
      wordSearchCompletedToday: scalar(`SELECT COUNT(*) FROM events WHERE type = 'wordsearch_completed'
        AND received_at >= ? AND received_at < ?`, today, tomorrow),
      notificationsEnabled: scalar('SELECT COUNT(*) FROM devices WHERE enabled = 1'),
    };
  }

  /** `[{ date, players }]` for the `days` days ending `today`, oldest first, zero-filled. */
  function playersPerDay(today = todayUtc(), days = TREND_DAYS) {
    const from = addDays(today, -(days - 1));
    const counts = new Map(db.prepare(`SELECT substr(received_at, 1, 10) AS day, COUNT(DISTINCT device) AS players
      FROM events WHERE received_at >= ? AND received_at < ? GROUP BY day`).all(from, addDays(today, 1))
      .map((r) => [r.day, r.players]));
    return Array.from({ length: days }, (_, i) => {
      const date = addDays(from, i);
      return { date, players: counts.get(date) ?? 0 };
    });
  }

  /**
   * Per published level, in app order: distinct devices that opened a question
   * in it and that completed it, over every retained event. Keyed by the level
   * id recorded at play time, so reordering keeps each level's history.
   */
  function funnel() {
    const ids = repo.publishedLevelIds();
    const tally = new Map();
    for (const row of db.prepare(`SELECT level_id, type, COUNT(DISTINCT device) AS devices FROM events
      WHERE type IN ('question_opened', 'level_completed') AND level_id IS NOT NULL
      GROUP BY level_id, type`).all()) {
      const entry = tally.get(row.level_id) ?? { opened: 0, completed: 0 };
      entry[row.type === 'question_opened' ? 'opened' : 'completed'] = row.devices;
      tally.set(row.level_id, entry);
    }
    const rows = ids.map((levelId, i) => ({ number: i + 1, levelId, ...(tally.get(levelId) ?? { opened: 0, completed: 0 }) }));
    const base = rows[0]?.opened ?? 0;
    const share = (n) => (base ? n / base : null);
    return {
      base,
      rows: rows.map((r) => ({ ...r, openedShare: share(r.opened), completedShare: share(r.completed) })),
      drop: biggestDrop(rows),
    };
  }

  /** `[{ help, count, share }]` for every help kind over the last `days` days, largest first. */
  function helps(today = todayUtc(), days = HELP_DAYS) {
    const counts = new Map(db.prepare(`SELECT help, COUNT(*) AS n FROM events
      WHERE type = 'help_used' AND received_at >= ? AND received_at < ? GROUP BY help`)
      .all(addDays(today, -(days - 1)), addDays(today, 1)).map((r) => [r.help, r.n]));
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    return {
      total,
      rows: HELPS.map((help) => ({ help, count: counts.get(help) ?? 0, share: total ? (counts.get(help) ?? 0) / total : 0 }))
        .sort((a, b) => b.count - a.count || HELPS.indexOf(a.help) - HELPS.indexOf(b.help)),
    };
  }

  /**
   * Day-N retention: of devices first seen on day X, the share seen again on
   * day X + N. Aggregated over the last `cohorts` cohorts whose day X + N has
   * fully ended (so it never counts today, which is still filling).
   *
   * "First seen" is the earliest retained event, so a device idle longer than
   * the retention window would count as new again; with a 180-day window and
   * cohorts from the last ~40 days that is rare.
   */
  function retention(today = todayUtc(), cohorts = RETENTION_COHORTS) {
    const measure = (n) => {
      const last = addDays(today, -(n + 1));
      const first = addDays(last, -(cohorts - 1));
      const row = db.prepare(`
        WITH firsts AS (
          SELECT device, substr(MIN(received_at), 1, 10) AS day FROM events GROUP BY device
        )
        SELECT COUNT(*) AS cohort,
          IFNULL(SUM(EXISTS (
            SELECT 1 FROM events e WHERE e.device = f.device
              AND e.received_at >= date(f.day, @plus) AND e.received_at < date(f.day, @plusOne)
          )), 0) AS returned
        FROM firsts f WHERE f.day BETWEEN @first AND @last`).get({ plus: `+${n} days`, plusOne: `+${n + 1} days`, first, last });
      return { days: n, from: first, to: last, cohort: row.cohort, returned: row.returned, rate: row.cohort ? row.returned / row.cohort : null };
    };
    return { d1: measure(1), d7: measure(7) };
  }

  /**
   * The daily word search over the last `days` days: boards started and
   * completed, distinct players who completed, average time and stars of a
   * completion, and words found.
   */
  function wordSearch(today = todayUtc(), days = WORD_SEARCH_DAYS) {
    const row = db.prepare(`SELECT
        IFNULL(SUM(type = 'wordsearch_started'), 0) AS started,
        IFNULL(SUM(type = 'wordsearch_completed'), 0) AS completed,
        COUNT(DISTINCT CASE WHEN type = 'wordsearch_completed' THEN device END) AS players,
        AVG(CASE WHEN type = 'wordsearch_completed' THEN seconds END) AS avgSeconds,
        AVG(CASE WHEN type = 'wordsearch_completed' THEN stars END) AS avgStars,
        IFNULL(SUM(type = 'wordsearch_word_found'), 0) AS wordsFound
      FROM events WHERE type IN ('wordsearch_started', 'wordsearch_word_found', 'wordsearch_completed')
        AND received_at >= ? AND received_at < ?`).get(addDays(today, -(days - 1)), addDays(today, 1));
    return { days, ...row, completionRate: row.started ? row.completed / row.started : null };
  }

  function dashboard(today = todayUtc()) {
    return {
      today, kpis: kpis(today), perDay: playersPerDay(today), funnel: funnel(), helps: helps(today), retention: retention(today), wordSearch: wordSearch(today),
    };
  }

  return { kpis, playersPerDay, funnel, helps, retention, wordSearch, dashboard };
}
