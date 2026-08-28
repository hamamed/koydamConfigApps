import { db } from '../db/index.js';
import { REPORT_REASONS, URGENT_REASONS } from '../utils/validate.js';

/**
 * Records a report.
 *
 * Returns `false` when this client already reported this item today. That's not an error worth
 * showing anyone — the person tapped twice, or reported from two devices — so the API answers
 * success either way and the counts stay honest.
 */
export function createReport({ itemId, reason, note, clientKey }) {
  const item = db.prepare('SELECT id FROM items WHERE id = ?').get(itemId);
  if (!item) return null;

  try {
    db.prepare(
      `INSERT INTO reports (item_id, reason, note, client_key, day)
       VALUES (?, ?, ?, ?, date('now'))`
    ).run(itemId, reason, note || '', clientKey || null);
    return true;
  } catch (error) {
    // The unique index is the dedupe; anything else is a real failure.
    if (String(error.message).includes('UNIQUE constraint failed')) return false;
    throw error;
  }
}

export function listReports({ status = 'open', page = 1, limit = 25 } = {}) {
  const where = [];
  const params = {};

  if (status !== 'all') {
    where.push('r.status = @status');
    params.status = status;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM reports r ${whereSql}`).get(params);
  const offset = (page - 1) * limit;

  const rows = db
    .prepare(
      `SELECT r.*, i.kind, i.title, i.category, i.preview_file, i.is_published,
              u.username AS resolver
         FROM reports r
         JOIN items i ON i.id = r.item_id
    LEFT JOIN users u ON u.id = r.resolved_by
        ${whereSql}
     -- Safety reports first regardless of age; everything else newest-first.
     ORDER BY CASE WHEN r.reason IN ('inappropriate', 'copyright') THEN 0 ELSE 1 END,
              r.created_at DESC
        LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit, offset });

  return {
    rows: rows.map((row) => ({
      ...row,
      reasonLabel: REPORT_REASONS[row.reason] || row.reason,
      isUrgent: URGENT_REASONS.has(row.reason),
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / limit)),
  };
}

export function setReportStatus(id, status, userId) {
  const allowed = ['open', 'resolved', 'dismissed'];
  if (!allowed.includes(status)) return false;

  const result = db
    .prepare(
      `UPDATE reports
          SET status = ?,
              resolved_at = CASE WHEN ? = 'open' THEN NULL ELSE datetime('now') END,
              resolved_by = CASE WHEN ? = 'open' THEN NULL ELSE ? END
        WHERE id = ?`
    )
    .run(status, status, status, userId ?? null, id);

  return result.changes > 0;
}

/** Resolves every open report on one item — the usual action after re-uploading a fixed pack. */
export function resolveAllForItem(itemId, userId) {
  return db
    .prepare(
      `UPDATE reports
          SET status = 'resolved', resolved_at = datetime('now'), resolved_by = ?
        WHERE item_id = ? AND status = 'open'`
    )
    .run(userId ?? null, itemId).changes;
}

export function openReportCount() {
  return db.prepare("SELECT COUNT(*) AS count FROM reports WHERE status = 'open'").get().count;
}

export function reportsForItem(itemId) {
  const rows = db
    .prepare(
      `SELECT reason, status, note, created_at
         FROM reports WHERE item_id = ?
     ORDER BY created_at DESC LIMIT 20`
    )
    .all(itemId);

  return rows.map((row) => ({ ...row, reasonLabel: REPORT_REASONS[row.reason] || row.reason }));
}

/**
 * Items ranked by how many people are complaining.
 *
 * Reports per thousand downloads, not raw count — a popular item naturally attracts more of both,
 * and a raw leaderboard would just re-rank the catalogue by popularity.
 */
export function mostReported(limit = 6) {
  return db
    .prepare(
      `SELECT i.id, i.kind, i.title, i.category, i.downloads, i.preview_file,
              COUNT(r.id) AS reports,
              ROUND(COUNT(r.id) * 1000.0 / MAX(i.downloads, 1), 2) AS ratePerThousand
         FROM reports r
         JOIN items i ON i.id = r.item_id
        WHERE r.status = 'open'
     GROUP BY i.id
     ORDER BY ratePerThousand DESC, reports DESC
        LIMIT ?`
    )
    .all(limit);
}

export function reasonBreakdown({ days = 30 } = {}) {
  const rows = db
    .prepare(
      `SELECT reason, COUNT(*) AS count
         FROM reports
        WHERE created_at >= datetime('now', ?)
     GROUP BY reason
     ORDER BY count DESC`
    )
    .all(`-${days} days`);

  return rows.map((row) => ({ ...row, label: REPORT_REASONS[row.reason] || row.reason }));
}
