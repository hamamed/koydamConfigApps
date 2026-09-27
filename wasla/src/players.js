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
export const HOUR_DAYS = 7;
/** The furthest players the front page names, and how close to the end counts as "near". */
export const FRONTIER_TOP = 10;
export const NEAR_END_LEVELS = 20;
const PACE_DAYS = 7;
const BUCKET_EDGES = [10, 25, 50, 100, 150];
/** The daily games, as their events name them (`<game>_completed`), in the order the ladder lists them. */
export const DAILY_GAMES = Object.freeze(['bubbles', 'wheel', 'guess', 'connect', 'wordsearch', 'marathon']);

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
      newToday: newSince(today, tomorrow),
      newMonth: newSince(addDays(today, -29), tomorrow),
      questionsSolvedToday: scalar(`SELECT COUNT(*) FROM events WHERE type = 'question_solved'
        AND received_at >= ? AND received_at < ?`, today, tomorrow),
    };
  }

  /** Devices whose first retained event falls in [from, to). */
  function newSince(from, to) {
    return scalar(`SELECT COUNT(*) FROM (SELECT MIN(received_at) AS first FROM events GROUP BY device)
      WHERE first >= ? AND first < ?`, from, to);
  }

  /** `[{ date, players }]`: devices first seen on each of the `days` days ending `today`, zero-filled. */
  function newPerDay(today = todayUtc(), days = TREND_DAYS) {
    const from = addDays(today, -(days - 1));
    const counts = new Map(db.prepare(`SELECT substr(first, 1, 10) AS day, COUNT(*) AS players
      FROM (SELECT MIN(received_at) AS first FROM events GROUP BY device)
      WHERE first >= ? AND first < ? GROUP BY day`).all(from, addDays(today, 1)).map((r) => [r.day, r.players]));
    return Array.from({ length: days }, (_, i) => {
      const date = addDays(from, i);
      return { date, players: counts.get(date) ?? 0 };
    });
  }

  /** `[{ date, levels, questions }]`: levels finished (not the daily puzzle) and questions solved per day. */
  function activityPerDay(today = todayUtc(), days = TREND_DAYS) {
    const from = addDays(today, -(days - 1));
    const rows = new Map(db.prepare(`SELECT substr(received_at, 1, 10) AS day,
        SUM(type = 'level_completed' AND level_number > 0) AS levels,
        SUM(type = 'question_solved') AS questions
      FROM events WHERE type IN ('level_completed', 'question_solved') AND received_at >= ? AND received_at < ?
      GROUP BY day`).all(from, addDays(today, 1)).map((r) => [r.day, r]));
    return Array.from({ length: days }, (_, i) => {
      const date = addDays(from, i);
      const row = rows.get(date);
      return { date, levels: row?.levels ?? 0, questions: row?.questions ?? 0 };
    });
  }

  /** `[{ hour, players }]` for hours 0–23 (UTC): distinct devices active in that hour over the last `days` days. */
  function byHour(today = todayUtc(), days = HOUR_DAYS) {
    const counts = new Map(db.prepare(`SELECT CAST(substr(received_at, 12, 2) AS INTEGER) AS hour, COUNT(DISTINCT device) AS players
      FROM events WHERE received_at >= ? AND received_at < ? GROUP BY hour`)
      .all(addDays(today, -(days - 1)), addDays(today, 1)).map((r) => [r.hour, r.players]));
    return Array.from({ length: 24 }, (_, hour) => ({ hour, players: counts.get(hour) ?? 0 }));
  }

  /** `{ total, rows: [{ game, count }] }`: daily games finished over the last `days` days, largest first. */
  function dailyGames(today = todayUtc(), days = TREND_DAYS) {
    const types = DAILY_GAMES.map((game) => `'${game}_completed'`).join(', ');
    const counts = new Map(db.prepare(`SELECT type, COUNT(*) AS n FROM events
      WHERE type IN (${types}) AND received_at >= ? AND received_at < ? GROUP BY type`)
      .all(addDays(today, -(days - 1)), addDays(today, 1)).map((r) => [r.type.replace(/_completed$/, ''), r.n]));
    const rows = DAILY_GAMES.map((game) => ({ game, count: counts.get(game) ?? 0 }))
      .sort((a, b) => b.count - a.count || DAILY_GAMES.indexOf(a.game) - DAILY_GAMES.indexOf(b.game));
    return { days, total: rows.reduce((sum, r) => sum + r.count, 0), rows };
  }

  /** Events stored today, over the last 7 and 30 days (UTC), and every retained one. */
  function eventCounts(today = todayUtc()) {
    const tomorrow = addDays(today, 1);
    const since = (from) => scalar('SELECT COUNT(*) FROM events WHERE received_at >= ? AND received_at < ?', from, tomorrow);
    return {
      today: since(today), week: since(addDays(today, -6)), month: since(addDays(today, -29)),
      total: scalar('SELECT COUNT(*) FROM events'),
    };
  }

  /** `[{ date, events }]`: events stored on each of the `days` days ending `today`, zero-filled. */
  function eventsPerDay(today = todayUtc(), days = TREND_DAYS) {
    const from = addDays(today, -(days - 1));
    const counts = new Map(db.prepare(`SELECT substr(received_at, 1, 10) AS day, COUNT(*) AS events
      FROM events WHERE received_at >= ? AND received_at < ? GROUP BY day`).all(from, addDays(today, 1))
      .map((r) => [r.day, r.events]));
    return Array.from({ length: days }, (_, i) => {
      const date = addDays(from, i);
      return { date, events: counts.get(date) ?? 0 };
    });
  }

  /** Players with a name on the leaderboards: all of them, and those made this month and today. */
  function named(today = todayUtc()) {
    const tomorrow = addDays(today, 1);
    return {
      total: scalar('SELECT COUNT(*) FROM profiles'),
      month: scalar('SELECT COUNT(*) FROM profiles WHERE created_at >= ? AND created_at < ?', addDays(today, -29), tomorrow),
      today: scalar('SELECT COUNT(*) FROM profiles WHERE created_at >= ? AND created_at < ?', today, tomorrow),
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

  /**
   * Who is furthest through the published levels, and when they will run out.
   *
   * A player's place is the furthest level (in today's order) they have finished,
   * by level id, so reordering the levels keeps everyone's history. Their pace is
   * the levels they finished for the first time in the last 7 days; at that pace,
   * `daysLeft` is how long the levels still ahead of them last — the number to
   * watch before adding more.
   */
  function frontier(today = todayUtc()) {
    const ids = repo.publishedLevelIds();
    const total = ids.length;
    const place = new Map(ids.map((id, i) => [id, i + 1]));
    const weekFrom = addDays(today, -(PACE_DAYS - 1));
    const tomorrow = addDays(today, 1);
    const byDevice = new Map();
    for (const row of db.prepare(`SELECT device, level_id, MIN(received_at) AS first FROM events
      WHERE type = 'level_completed' AND level_id IS NOT NULL GROUP BY device, level_id`).all()) {
      const at = place.get(row.level_id);
      if (!at) continue; // a level since unpublished
      const entry = byDevice.get(row.device) ?? { device: row.device, highest: 0, weekLevels: 0 };
      entry.highest = Math.max(entry.highest, at);
      if (row.first >= weekFrom && row.first < tomorrow) entry.weekLevels += 1;
      byDevice.set(row.device, entry);
    }
    const everyone = [...byDevice.values()].map((p) => {
      const remaining = total - p.highest;
      const pace = p.weekLevels / PACE_DAYS;
      return { ...p, remaining, daysLeft: remaining === 0 ? 0 : pace > 0 ? Math.ceil(remaining / pace) : null };
    }).sort((a, b) => b.highest - a.highest || b.weekLevels - a.weekLevels || a.device.localeCompare(b.device));

    const top = everyone.slice(0, FRONTIER_TOP);
    const names = new Map(top.length ? db.prepare(`SELECT pd.device, p.username FROM profile_devices pd
      JOIN profiles p ON p.id = pd.profile_id WHERE pd.device IN (${top.map(() => '?').join(', ')})`)
      .all(...top.map((p) => p.device)).map((r) => [r.device, r.username]) : []);
    const waiting = everyone.filter((p) => p.remaining > 0 && p.daysLeft !== null).map((p) => p.daysLeft);

    const edges = [...BUCKET_EDGES.filter((edge) => edge < total), total];
    const buckets = edges.map((to, i) => {
      const from = i ? edges[i - 1] + 1 : 1;
      return { label: from === to ? String(to) : `${from}–${to}`, players: everyone.filter((p) => p.highest >= from && p.highest <= to).length };
    });

    return {
      total,
      players: everyone.length,
      finishedAll: total ? everyone.filter((p) => p.remaining === 0).length : 0,
      nearEnd: everyone.filter((p) => p.remaining > 0 && p.remaining <= NEAR_END_LEVELS).length,
      soonest: waiting.length ? Math.min(...waiting) : null,
      top: top.map((p) => ({ ...p, username: names.get(p.device) ?? null })),
      buckets: total ? buckets : [],
    };
  }

  /** Everything the panel's front page shows. */
  function home(today = todayUtc()) {
    return {
      today, kpis: kpis(today), perDay: playersPerDay(today), newPerDay: newPerDay(today),
      activity: activityPerDay(today), hours: byHour(today), dailyGames: dailyGames(today),
      helps: helps(today), retention: retention(today), funnel: funnel(), named: named(today),
      events: eventCounts(today), eventsPerDay: eventsPerDay(today), frontier: frontier(today),
    };
  }

  return { kpis, frontier, eventCounts, eventsPerDay, playersPerDay, newPerDay, activityPerDay, byHour, dailyGames, named, funnel, helps, retention, wordSearch, dashboard, home };
}
