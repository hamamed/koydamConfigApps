import { db } from '../db/index.js';
import { REPORT_REASONS, URGENT_REASONS } from '../utils/validate.js';

/**
 * Records a report.
 *
 * Returns `false` when this client already reported this skin today. That's not an error worth
 * showing anyone — the person tapped twice, or reported from two devices — so the API answers
 * success either way and the counts stay honest.
 */
export function createReport({ skinId, reason, note, clientKey }) {
  const skin = db.prepare('SELECT id FROM skins WHERE id = ?').get(skinId);
  if (!skin) return null;

  try {
    db.prepare(
      `INSERT INTO reports (skin_id, reason, note, client_key, day)
       VALUES (?, ?, ?, ?, date('now'))`
    ).run(skinId, reason, note || '', clientKey || null);
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
      `SELECT r.*, s.title, s.category, s.preview_file, s.is_published,
              u.username AS resolver
         FROM reports r
         JOIN skins s ON s.id = r.skin_id
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

/** Resolves every open report on one skin — the usual action after fixing its template. */
export function resolveAllForSkin(skinId, userId) {
  return db
    .prepare(
      `UPDATE reports
          SET status = 'resolved', resolved_at = datetime('now'), resolved_by = ?
        WHERE skin_id = ? AND status = 'open'`
    )
    .run(userId ?? null, skinId).changes;
}

export function openReportCount() {
  return db.prepare("SELECT COUNT(*) AS count FROM reports WHERE status = 'open'").get().count;
}

export function reportsForSkin(skinId) {
  const rows = db
    .prepare(
      `SELECT reason, status, note, created_at
         FROM reports WHERE skin_id = ?
     ORDER BY created_at DESC LIMIT 20`
    )
    .all(skinId);

  return rows.map((row) => ({ ...row, reasonLabel: REPORT_REASONS[row.reason] || row.reason }));
}

/**
 * Skins ranked by how many people are complaining.
 *
 * Reports per thousand downloads, not raw count — a popular skin naturally attracts more of both,
 * and a raw leaderboard would just re-rank the catalogue by popularity.
 */
export function mostReported(limit = 6) {
  return db
    .prepare(
      `SELECT s.id, s.title, s.category, s.downloads, s.preview_file,
              COUNT(r.id) AS reports,
              ROUND(COUNT(r.id) * 1000.0 / MAX(s.downloads, 1), 2) AS ratePerThousand
         FROM reports r
         JOIN skins s ON s.id = r.skin_id
        WHERE r.status = 'open'
     GROUP BY s.id
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
