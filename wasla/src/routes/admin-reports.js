import { REASON_KEYS, REASONS } from '../reports.js';

/**
 * What players said is wrong, and what was done about it.
 *
 * A report stays after it is dealt with: the count beside a question is how
 * many times it has ever been reported, which is the number that says «look at
 * this one» far better than a single open complaint does.
 */
export function registerReports(router, { reports, repo }) {
  const STATUSES = Object.freeze({ open: 'المفتوحة', resolved: 'المعالَجة', all: 'الكل' });

  const page = (req, res) => {
    const status = Object.keys(STATUSES).includes(String(req.query.status)) ? String(req.query.status) : 'open';
    const reason = REASON_KEYS.includes(String(req.query.reason)) ? String(req.query.reason) : '';
    res.render('reports', {
      title: 'البلاغات',
      rows: reports.list({ status, reason }),
      counts: reports.counts(),
      reasons: REASONS,
      statuses: STATUSES,
      status,
      reason,
      currentUrl: req.originalUrl,
    });
  };

  /** Back to the listing the button was pressed on. */
  const back = (req) => {
    const where = String(req.body.back ?? '').trim();
    return where.startsWith('/admin/reports') ? where : '/admin/reports';
  };

  router.get('/reports', page);

  router.post('/reports/:id/resolve', (req, res) => {
    const done = req.body.resolved !== '0';
    const changed = reports.setResolved(req.params.id, done);
    req.flash(changed ? 'success' : 'danger', changed
      ? (done ? 'عُلّم البلاغ كمعالَج.' : 'أُعيد البلاغ إلى المفتوحة.')
      : 'لا بلاغ بهذا الرقم.');
    res.redirect(back(req));
  });

  /** Every open report about one question at once — what you press after fixing it. */
  router.post('/reports/question/:id/resolve', (req, res) => {
    const closed = reports.resolveQuestion(req.params.id);
    const question = repo.getQuestion(Number(req.params.id));
    req.flash('success', closed
      ? `عولجت ${closed} بلاغاً عن «${question?.answer ?? ''}».`
      : 'لا بلاغات مفتوحة عن هذا السؤال.');
    res.redirect(back(req));
  });

  router.post('/reports/:id/delete', (req, res) => {
    const gone = reports.remove(req.params.id);
    req.flash(gone ? 'success' : 'danger', gone ? 'حُذف البلاغ.' : 'لا بلاغ بهذا الرقم.');
    res.redirect(back(req));
  });
}
