import multer from 'multer';

import { DEFAULT_TEAM_ID, DEFAULT_TOPIC, MAX_KEY_BYTES } from '../apns-credentials.js';
import { csrfProtect } from '../middleware/auth.js';
import { MAX_BODY, MAX_TITLE, NOT_SET_UP, readCompose } from '../notifications.js';

/** Push notifications: compose and send, history, and the APNs key setup. */
export function registerNotifications(router, { repo, devices, notifications, apnsCredentials }) {
  const blank = { title: '', body: '', level: '', target: 'all', device: '' };

  const renderCompose = (res, { values = blank, error = null, status = 200 } = {}) => res.status(status).render('notifications', {
    title: 'الإشعارات',
    values,
    counts: devices.counts(),
    publishedCount: repo.publishedLevels().length,
    history: notifications.history(),
    apns: apnsCredentials.status(),
    maxTitle: MAX_TITLE,
    maxBody: MAX_BODY,
    ...(error ? { flash: { type: 'danger', message: error } } : {}),
  });

  const formValues = (body) => ({
    title: String(body.title ?? ''),
    body: String(body.body ?? ''),
    level: String(body.level ?? ''),
    target: String(body.target ?? 'all'),
    device: String(body.device ?? ''),
  });

  router.get('/notifications', (_req, res) => renderCompose(res));

  // The live count beside the target picker.
  router.get('/notifications/audience', (req, res) => {
    const target = String(req.query.target ?? 'all');
    res.set('Cache-Control', 'no-store');
    res.json({ count: notifications.audience({ target, device: String(req.query.device ?? '').trim() }) });
  });

  /** Checks the form; renders the compose page with the error and returns null when it fails. */
  const checked = (req, res) => {
    const values = formValues(req.body);
    if (!apnsCredentials.status().configured) {
      renderCompose(res, { values, error: NOT_SET_UP, status: 409 });
      return null;
    }
    const { message, error } = readCompose(values, { publishedCount: repo.publishedLevels().length });
    if (error) {
      renderCompose(res, { values, error, status: 400 });
      return null;
    }
    return { values, message };
  };

  router.post('/notifications/confirm', (req, res) => {
    const form = checked(req, res);
    if (!form) return;
    const audience = notifications.audience(form.message);
    if (!audience) {
      return renderCompose(res, {
        values: form.values,
        status: 400,
        error: form.message.target === 'device'
          ? 'هذا الجهاز غير مسجَّل، أو الإشعارات معطّلة عليه.'
          : 'لا جهاز مفعَّل الإشعارات يطابق هذه الفئة بعد.',
      });
    }
    res.render('notifications-confirm', { title: 'إرسال الإشعار؟', message: form.message, audience });
  });

  router.post('/notifications/send', async (req, res, next) => {
    try {
      const form = checked(req, res);
      if (!form) return;
      if (req.body.confirmed !== '1') return renderCompose(res, { values: form.values, error: 'أكّد الإرسال أولاً.', status: 400 });

      const result = await notifications.send(form.message, { userId: req.user?.id ?? null });
      if (result.error) return renderCompose(res, { values: form.values, error: result.error, status: 409 });

      const { total, sent, failed, disabled, errors } = result.summary;
      const reasons = Object.entries(errors).map(([reason, n]) => `${reason} ×${n}`).join(', ');
      req.flash(failed ? 'warning' : 'success',
        `Sent to ${sent} of ${total} device(s). Failed: ${failed}. Disabled (token no longer valid): ${disabled}.${reasons ? ` Reasons: ${reasons}.` : ''}`);
      res.redirect('/admin/notifications');
    } catch (err) {
      next(err);
    }
  });

  // ── Setup ───────────────────────────────────────────────────────────────

  const renderSetup = (res, { values = null, error = null, status = 200 } = {}) => {
    const apns = apnsCredentials.status();
    res.status(status).render('notifications-setup', {
      title: 'إعداد الإشعارات',
      apns,
      values: values ?? { keyId: apns.keyId ?? '', teamId: apns.teamId, topic: apns.topic },
      defaults: { teamId: DEFAULT_TEAM_ID, topic: DEFAULT_TOPIC },
      ...(error ? { flash: { type: 'danger', message: error } } : {}),
    });
  };

  router.get('/notifications/setup', (_req, res) => renderSetup(res));

  // The key is a few hundred bytes; anything much bigger is not one. Parsed
  // into memory, checked, and only then written under data/apns.
  const uploadKey = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_KEY_BYTES, files: 1 } }).single('key');

  router.post('/notifications/setup', (req, res, next) => uploadKey(req, res, (err) => {
    if (err) {
      req.flash('danger', err.code === 'LIMIT_FILE_SIZE' ? 'هذا الملف أكبر من أن يكون مفتاح ‎.p8 لـAPNs.' : 'تعذّرت قراءة الملف المرفوع.');
      return res.redirect('/admin/notifications/setup');
    }
    return csrfProtect(req, res, next);
  }), (req, res) => {
    const values = { keyId: String(req.body.keyId ?? ''), teamId: String(req.body.teamId ?? ''), topic: String(req.body.topic ?? '') };
    const result = apnsCredentials.save({ file: req.file?.buffer, ...values });
    if (result.error) return renderSetup(res, { values, error: result.error, status: 400 });
    req.flash('success', result.replacedKey
      ? `رُفع المفتاح (Key ID ${result.status.keyId}). أرسل تجربة إلى جهاز واحد للتأكد.`
      : 'حُفظت المعرّفات. وبقي المفتاح المرفوع كما هو.');
    res.redirect('/admin/notifications/setup');
  });

  router.post('/notifications/setup/remove', (req, res) => {
    apnsCredentials.remove();
    req.flash('success', 'حُذف مفتاح APNs ومعرّفاته. لا يمكن الإرسال حتى يُرفع مفتاح جديد.');
    res.redirect('/admin/notifications/setup');
  });
}
