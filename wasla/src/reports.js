/**
 * What players say is wrong with a question.
 *
 * A report is a reason from a short list, and optionally a line of their own.
 * The list is short on purpose: «الجواب خاطئ» and «الدليل غير واضح» need
 * different fixes, and a free-text box alone turns every report into reading.
 *
 * Reports are kept after they are dealt with. A question reported once is a
 * player having a bad day; the same question reported eight times is a
 * question with something wrong in it, and that only shows if the old ones
 * stay.
 */

/** The reasons the app offers, in the order it shows them. */
export const REASONS = Object.freeze({
  wrong: 'الجواب خاطئ',
  unclear: 'الدليل غير واضح أو ناقص',
  spelling: 'خطأ إملائي',
  image: 'الصورة لا تناسب السؤال',
  duplicate: 'السؤال مكرّر',
  offensive: 'محتوى غير لائق',
  other: 'سبب آخر',
});

export const REASON_KEYS = Object.freeze(Object.keys(REASONS));
export const MAX_NOTE = 300;
/** One device may not file more than this in an hour. */
export const PER_DEVICE_HOURLY = 20;

/** A report from the app: `{ report }` in the shape stored, or `{ error }`. */
export function readReport(body) {
  if (!body || typeof body !== 'object') return { error: 'Send a JSON object.' };
  const reason = String(body.reason ?? '').trim();
  if (!REASON_KEYS.includes(reason)) {
    return { error: `"reason" is one of: ${REASON_KEYS.join(', ')}.` };
  }
  const note = String(body.note ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE);
  const device = String(body.device ?? '').trim().slice(0, 64);
  return { report: { reason, note: note || null, device: device || null } };
}

export function createReports(db) {
  /**
   * Files a report. `{ id }`, or `{ error }` when the question is gone or the
   * device has filed too many this hour.
   */
  function add(questionId, { reason, note = null, device = null }) {
    const exists = db.prepare('SELECT 1 FROM questions WHERE id = ?').get(questionId);
    if (!exists) return { error: 'No such question.' };
    if (device) {
      const recent = db.prepare(`SELECT COUNT(*) AS n FROM question_reports
        WHERE device = ? AND created_at >= datetime('now', '-1 hour')`).get(device).n;
      if (recent >= PER_DEVICE_HOURLY) return { error: 'Too many reports from this device; try later.' };
    }
    const { lastInsertRowid } = db.prepare(`INSERT INTO question_reports (question_id, reason, note, device)
      VALUES (?, ?, ?, ?)`).run(questionId, reason, note, device);
    return { id: lastInsertRowid };
  }

  /**
   * Reports newest first, with the question they are about.
   * `status` is 'open' (the default), 'resolved' or 'all'; `reason` narrows further.
   */
  function list({ status = 'open', reason = '', limit = 300 } = {}) {
    const where = ['1 = 1'];
    if (status === 'open') where.push('r.resolved_at IS NULL');
    if (status === 'resolved') where.push('r.resolved_at IS NOT NULL');
    if (REASON_KEYS.includes(reason)) where.push('r.reason = @reason');
    return db.prepare(`SELECT r.*, q.answer, q.clue, q.title, q.type, q.image_file AS imageFile,
        (SELECT COUNT(*) FROM question_reports o WHERE o.question_id = r.question_id) AS timesReported
      FROM question_reports r JOIN questions q ON q.id = r.question_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.created_at DESC, r.id DESC LIMIT @limit`).all({ reason, limit });
  }

  /** Just how many are waiting — the sidebar asks this on every page. */
  const openCount = () => db.prepare('SELECT COUNT(*) AS n FROM question_reports WHERE resolved_at IS NULL').get().n;

  /** `{ open, resolved, total, week, byReason: {key: n}, worst: [{questionId, answer, n}] }` */
  function counts() {
    const totals = db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN resolved_at IS NOT NULL THEN 1 ELSE 0 END) AS resolved,
      SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS week
      FROM question_reports`).get();
    const byReason = Object.fromEntries(REASON_KEYS.map((key) => [key, 0]));
    for (const row of db.prepare('SELECT reason, COUNT(*) AS n FROM question_reports GROUP BY reason').all()) {
      if (byReason[row.reason] !== undefined) byReason[row.reason] = row.n;
    }
    // The questions players keep reporting: what to look at first.
    const worst = db.prepare(`SELECT r.question_id AS questionId, q.answer, COUNT(*) AS n
      FROM question_reports r JOIN questions q ON q.id = r.question_id
      WHERE r.resolved_at IS NULL
      GROUP BY r.question_id ORDER BY n DESC, MAX(r.created_at) DESC LIMIT 5`).all();
    return {
      total: totals.total ?? 0,
      open: totals.open ?? 0,
      resolved: totals.resolved ?? 0,
      week: totals.week ?? 0,
      byReason,
      worst,
    };
  }

  /** Marks one report dealt with, or puts it back. True when a row changed. */
  const setResolved = (id, resolved) => db.prepare(
    `UPDATE question_reports SET resolved_at = ${resolved ? "datetime('now')" : 'NULL'} WHERE id = ?`,
  ).run(Number(id)).changes > 0;

  /** Marks every open report about one question dealt with; returns how many. */
  const resolveQuestion = (questionId) => db.prepare(
    "UPDATE question_reports SET resolved_at = datetime('now') WHERE question_id = ? AND resolved_at IS NULL",
  ).run(Number(questionId)).changes;

  const remove = (id) => db.prepare('DELETE FROM question_reports WHERE id = ?').run(Number(id)).changes > 0;

  /** Throws away the reports already dealt with; the open ones stay. */
  const clearResolved = () => db.prepare('DELETE FROM question_reports WHERE resolved_at IS NOT NULL').run().changes;

  return { add, list, counts, openCount, setResolved, resolveQuestion, remove, clearResolved };
}
