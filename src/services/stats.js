import { db } from '../db/index.js';
import { storageUsage } from './images.js';

/** Headline counters for the dashboard. */
export function overview() {
  const totals = db
    .prepare(
      `SELECT
         COUNT(*)                                   AS totalSkins,
         COALESCE(SUM(downloads), 0)                AS totalDownloads,
         COALESCE(SUM(is_featured), 0)              AS featuredCount,
         COALESCE(SUM(CASE WHEN is_published = 0 THEN 1 ELSE 0 END), 0) AS draftCount
       FROM skins`
    )
    .get();

  const today = db
    .prepare("SELECT COUNT(*) AS count FROM download_events WHERE day = date('now')")
    .get().count;

  const last7 = db
    .prepare("SELECT COUNT(*) AS count FROM download_events WHERE created_at >= datetime('now', '-7 days')")
    .get().count;

  const previous7 = db
    .prepare(
      `SELECT COUNT(*) AS count FROM download_events
        WHERE created_at >= datetime('now', '-14 days')
          AND created_at <  datetime('now', '-7 days')`
    )
    .get().count;

  return {
    ...totals,
    downloadsToday: today,
    downloadsLast7: last7,
    // Percentage change week on week. From a zero baseline any growth is "new", not infinite.
    trend: previous7 === 0 ? (last7 > 0 ? 100 : 0) : Math.round(((last7 - previous7) / previous7) * 100),
  };
}

/**
 * Daily download counts for the last `days` days, with empty days filled in.
 *
 * Without the zero-fill, a quiet Tuesday simply vanishes from the chart and every gap silently
 * compresses the time axis — which makes a flat week look like steady growth.
 */
export function downloadSeries(days = 14) {
  const rows = db
    .prepare(
      `SELECT day, COUNT(*) AS count
         FROM download_events
        WHERE created_at >= datetime('now', ?)
     GROUP BY day`
    )
    .all(`-${days} days`);

  const counts = new Map(rows.map((row) => [row.day, row.count]));
  const series = [];

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - offset);
    const day = date.toISOString().slice(0, 10);
    series.push({ day, count: counts.get(day) || 0 });
  }
  return series;
}

export function categoryBreakdown() {
  return db
    .prepare(
      `SELECT category,
              COUNT(*)                    AS skins,
              COALESCE(SUM(downloads), 0) AS downloads
         FROM skins
        WHERE is_published = 1
     GROUP BY category
     ORDER BY downloads DESC`
    )
    .all();
}

export function topSkins(limit = 6) {
  return db
    .prepare(
      `SELECT s.id, s.title, s.category, s.downloads, s.preview_file, s.is_featured,
              (SELECT COUNT(*) FROM download_events de
                WHERE de.skin_id = s.id
                  AND de.created_at >= datetime('now', '-7 days')) AS recent
         FROM skins s
        WHERE s.is_published = 1
     ORDER BY recent DESC, s.downloads DESC
        LIMIT ?`
    )
    .all(limit);
}

export function recentActivity(limit = 8) {
  return db
    .prepare(
      `SELECT a.action, a.subject, a.detail, a.created_at, u.username
         FROM audit_log a
    LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.created_at DESC
        LIMIT ?`
    )
    .all(limit);
}

/** Per-skin download history, used on the detail page. */
export function skinSeries(skinId, days = 14) {
  const rows = db
    .prepare(
      `SELECT day, COUNT(*) AS count
         FROM download_events
        WHERE skin_id = ? AND created_at >= datetime('now', ?)
     GROUP BY day`
    )
    .all(skinId, `-${days} days`);

  const counts = new Map(rows.map((row) => [row.day, row.count]));
  const series = [];

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - offset);
    const day = date.toISOString().slice(0, 10);
    series.push({ day, count: counts.get(day) || 0 });
  }
  return series;
}

/**
 * What people looked for, split by whether the catalogue could answer.
 *
 * `missed` is the valuable half — a ranked list of demand you aren't serving yet.
 */
export function searchInsights({ days = 14, limit = 6 } = {}) {
  const missed = db
    .prepare(
      `SELECT term, COUNT(*) AS searches, MAX(created_at) AS last_seen
         FROM search_events
        WHERE results = 0 AND created_at >= datetime('now', ?)
     GROUP BY term
     ORDER BY searches DESC, last_seen DESC
        LIMIT ?`
    )
    .all(`-${days} days`, limit);

  const top = db
    .prepare(
      `SELECT term, COUNT(*) AS searches, AVG(results) AS avg_results
         FROM search_events
        WHERE created_at >= datetime('now', ?)
     GROUP BY term
     ORDER BY searches DESC
        LIMIT ?`
    )
    .all(`-${days} days`, limit);

  const total = db
    .prepare("SELECT COUNT(*) AS count FROM search_events WHERE created_at >= datetime('now', ?)")
    .get(`-${days} days`).count;

  return { missed, top, total, days };
}

/**
 * Daily unique downloaders.
 *
 * The counter in `skins.downloads` measures actions; this measures *people*. They diverge exactly
 * when it matters — a day where the same handful of users grab twenty skins each looks identical
 * to a day of real growth if you only watch the total.
 */
export function uniqueClientSeries(days = 14) {
  const rows = db
    .prepare(
      `SELECT day, COUNT(DISTINCT client_key) AS count
         FROM download_events
        WHERE created_at >= datetime('now', ?) AND client_key IS NOT NULL
     GROUP BY day`
    )
    .all(`-${days} days`);

  return fillDays(rows, days);
}

/** Downloads per category over time, for the stacked view. */
export function categorySeries(days = 14) {
  const rows = db
    .prepare(
      `SELECT s.category, de.day, COUNT(*) AS count
         FROM download_events de
         JOIN skins s ON s.id = de.skin_id
        WHERE de.created_at >= datetime('now', ?)
     GROUP BY s.category, de.day`
    )
    .all(`-${days} days`);

  const byCategory = new Map();
  for (const row of rows) {
    if (!byCategory.has(row.category)) byCategory.set(row.category, []);
    byCategory.get(row.category).push(row);
  }

  return [...byCategory.entries()].map(([category, entries]) => ({
    category,
    series: fillDays(entries, days),
    total: entries.reduce((sum, entry) => sum + entry.count, 0),
  }));
}

/**
 * Biggest movers: this period against the one before it.
 *
 * Skins with almost no history are excluded — going from one download to three is a 200% rise and
 * tells you nothing, but it will dominate any list sorted by percentage.
 */
export function topMovers({ days = 14, limit = 8, minimum = 5 } = {}) {
  return db
    .prepare(
      `SELECT s.id, s.title, s.category, s.preview_file,
              SUM(CASE WHEN de.created_at >= datetime('now', @current) THEN 1 ELSE 0 END) AS recent,
              SUM(CASE WHEN de.created_at <  datetime('now', @current)
                        AND de.created_at >= datetime('now', @previous) THEN 1 ELSE 0 END) AS prior
         FROM download_events de
         JOIN skins s ON s.id = de.skin_id
        WHERE de.created_at >= datetime('now', @previous)
     GROUP BY s.id
       HAVING recent + prior >= @minimum
     ORDER BY (recent - prior) DESC
        LIMIT @limit`
    )
    .all({
      current: `-${days} days`,
      previous: `-${days * 2} days`,
      limit,
      minimum,
    })
    .map((row) => ({
      ...row,
      change: row.prior === 0
        ? (row.recent > 0 ? 100 : 0)
        : Math.round(((row.recent - row.prior) / row.prior) * 100),
    }));
}

/** Which tags actually pull downloads, as opposed to which are simply used most. */
export function tagPerformance({ days = 30, limit = 10 } = {}) {
  return db
    .prepare(
      `SELECT t.name,
              COUNT(DISTINCT st.skin_id) AS skins,
              COUNT(de.id) AS downloads
         FROM tags t
         JOIN skin_tags st ON st.tag_id = t.id
    LEFT JOIN download_events de
           ON de.skin_id = st.skin_id AND de.created_at >= datetime('now', @window)
     GROUP BY t.id
       HAVING skins > 0
     ORDER BY downloads DESC, skins DESC
        LIMIT @limit`
    )
    .all({ window: `-${days} days`, limit });
}

/** Headline numbers for a chosen window, each with its change against the preceding one. */
export function periodSummary(days = 14) {
  const count = (table, column, from, to) =>
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM ${table}
          WHERE ${column} >= datetime('now', ?)
            ${to ? `AND ${column} < datetime('now', ?)` : ''}`
      )
      .get(...(to ? [from, to] : [from])).count;

  const current = `-${days} days`;
  const previous = `-${days * 2} days`;

  const downloads = count('download_events', 'created_at', current);
  const downloadsPrior = count('download_events', 'created_at', previous, current);

  const reports = count('reports', 'created_at', current);
  const reportsPrior = count('reports', 'created_at', previous, current);

  const published = count('skins', 'created_at', current);

  const uniques = db
    .prepare(
      `SELECT COUNT(DISTINCT client_key) AS count FROM download_events
        WHERE created_at >= datetime('now', ?) AND client_key IS NOT NULL`
    )
    .get(current).count;

  const change = (now, before) =>
    before === 0 ? (now > 0 ? 100 : 0) : Math.round(((now - before) / before) * 100);

  return {
    days,
    downloads,
    downloadsChange: change(downloads, downloadsPrior),
    uniques,
    published,
    reports,
    reportsChange: change(reports, reportsPrior),
  };
}

/** Shared zero-fill so every series covers the same days, including quiet ones. */
function fillDays(rows, days) {
  const counts = new Map(rows.map((row) => [row.day, row.count]));
  const series = [];

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - offset);
    const day = date.toISOString().slice(0, 10);
    series.push({ day, count: counts.get(day) || 0 });
  }
  return series;
}

export async function storage() {
  return storageUsage();
}
