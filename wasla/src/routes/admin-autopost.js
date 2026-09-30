import { MAX_TIMES } from '../autopost.js';
import { TARGETS } from '../meta-publish.js';

/**
 * Five posts a day, each a little before one of the players' busy hours (GMT):
 * morning, midday, the afternoon peak, and the evening.
 */
export const SUGGESTED_TIMES = Object.freeze(['09:00', '12:00', '15:00', '17:00', '20:00']);

/**
 * «النشر التلقائي»: connecting the game's Facebook Page (and its Instagram), the
 * daily times and where to post, posting by hand, and what was posted.
 */
export function registerAutopost(router, { autopost, metaAccount }) {
  const on = (value) => value === 'on' || value === '1';

  router.get('/autopost', (_req, res) => {
    const schedule = autopost.schedule();
    res.render('autopost', {
      title: 'النشر التلقائي',
      meta: metaAccount.status(),
      schedule,
      maxTimes: MAX_TIMES,
      suggestedTimes: SUGGESTED_TIMES,
      targets: TARGETS,
      upcoming: autopost.upcoming(),
      history: autopost.history(),
    });
  });

  router.post('/autopost/connect', async (req, res, next) => {
    try {
      const result = await metaAccount.connect(req.body.token);
      if (result.error) {
        req.flash('danger', result.error);
      } else {
        const { pageName, igUsername } = result.status;
        req.flash('success', igUsername
          ? `رُبطت صفحة «${pageName}» وحساب إنستغرام @${igUsername}.`
          : `رُبطت صفحة «${pageName}». لا حساب إنستغرام مرتبط بها، فلن يُنشر على إنستغرام.`);
      }
      res.redirect('/admin/autopost');
    } catch (err) {
      next(err);
    }
  });

  router.post('/autopost/disconnect', (req, res) => {
    metaAccount.disconnect();
    req.flash('success', 'أُزيل ربط الصفحة، وتوقّف النشر التلقائي حتى تُربط من جديد.');
    res.redirect('/admin/autopost');
  });

  router.post('/autopost/schedule', (req, res) => {
    const result = autopost.saveSchedule({
      enabled: on(req.body.enabled),
      // One field per time; the empty ones are the times not wanted.
      times: [req.body.times ?? []].flat().join(','),
      targets: req.body.targets ?? [],
      showCredit: on(req.body.showCredit),
    });
    if (result.error) {
      req.flash('danger', result.error);
    } else if (!result.schedule.enabled) {
      req.flash('success', 'حُفظت المواعيد، والنشر التلقائي متوقّف.');
    } else {
      req.flash('success', metaAccount.status().connected
        ? 'حُفظت المواعيد، والنشر التلقائي يعمل.'
        : 'حُفظت المواعيد. يبدأ النشر حين تُربط الصفحة.');
    }
    res.redirect('/admin/autopost');
  });

  router.post('/autopost/now', async (req, res, next) => {
    try {
      const questionId = Number(req.body.questionId) > 0 ? Number(req.body.questionId) : null;
      const outcome = await autopost.postNow({ questionId });
      if (outcome.error) {
        req.flash('danger', outcome.error);
      } else {
        const done = outcome.results.filter((r) => r.ok).map((r) => TARGETS[r.target].label);
        const failed = outcome.results.filter((r) => !r.ok).map((r) => TARGETS[r.target].label);
        req.flash(failed.length ? (done.length ? 'warning' : 'danger') : 'success', [
          done.length ? `نُشر السؤال ${outcome.question.id}: ${done.join('، ')}.` : '',
          failed.length ? `لم يُنشر: ${failed.join('، ')} — السبب في السجل أدناه.` : '',
        ].filter(Boolean).join(' '));
      }
      res.redirect('/admin/autopost');
    } catch (err) {
      next(err);
    }
  });
}
