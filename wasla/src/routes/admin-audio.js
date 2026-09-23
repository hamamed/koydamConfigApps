import multer from 'multer';

import { clockText, LICENCES, MAX_CATEGORY, MAX_SECONDS, MAX_TITLE, MIN_SECONDS } from '../audio-clips.js';
import { config } from '../config.js';

/**
 * The sound library: upload a sound, cut the piece you want out of it, and keep
 * that piece in a category, with what licence lets it be played. A clip in the
 * library can be turned into a question in one click, which opens the question
 * form with the sound already chosen and in the clip's own category.
 *
 * Nothing here downloads audio from anywhere — a clip is cut from a file you
 * hand the panel, and every clip carries where it came from.
 */
export function registerAudio(router, { audioClips, repo, titleNames }) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxAudioBytes } })
    .single('sound');

  const page = (res, { category = null, ...extra } = {}) => res.render('audio', {
    title: 'مكتبة الأصوات',
    clips: audioClips.list({ category }).map((c) => ({ ...c, length: clockText(c.seconds) })),
    groups: audioClips.categories(),
    // The same categories every question box offers, so the two lists never drift.
    titles: titleNames(),
    chosen: category,
    total: audioClips.list().length,
    licences: LICENCES,
    maxTitle: MAX_TITLE,
    maxCategory: MAX_CATEGORY,
    minSeconds: MIN_SECONDS,
    maxSeconds: MAX_SECONDS,
    maxMb: Math.round(config.maxAudioBytes / 1024 / 1024) || 1,
    draft: { title: '', category: '', start: '0:00', seconds: '8', source: '', licence: '', author: '' },
    ...extra,
  });

  // `?category=حيوانات` shows one category; `?category=` those with none.
  router.get('/audio', (req, res) => page(res, {
    category: req.query.category === undefined ? null : String(req.query.category),
  }));

  router.post('/audio', (req, res, next) => {
    upload(req, res, async (err) => {
      if (err) {
        req.flash('danger', `الملف أكبر من ${Math.round(config.maxAudioBytes / 1024 / 1024) || 1} ميغابايت.`);
        return res.redirect('/admin/audio');
      }
      try {
        if (!req.file?.buffer?.length) {
          req.flash('danger', 'اختر ملف صوت.');
          return res.redirect('/admin/audio');
        }
        const result = await audioClips.save(req.file.buffer, {
          title: req.body.title,
          category: req.body.category,
          start: req.body.start,
          seconds: req.body.seconds,
          source: req.body.source,
          licence: req.body.licence,
          author: req.body.author,
        });
        if (result.error) {
          req.flash('danger', result.error);
          return res.redirect('/admin/audio');
        }
        req.flash('success', `حُفظ «${result.clip.title}» — ${clockText(result.clip.seconds)}`
          + `${result.clip.category ? ` · ${result.clip.category}` : ''}.`);
        res.redirect('/admin/audio');
      } catch (error) {
        next(error);
      }
    });
  });

  router.post('/audio/:id', (req, res) => {
    const result = audioClips.update(req.params.id, req.body);
    req.flash(result.error ? 'danger' : 'success', result.error ?? 'حُفظت بيانات المقطع.');
    res.redirect('/admin/audio');
  });

  router.post('/audio/:id/delete', async (req, res, next) => {
    try {
      const result = await audioClips.remove(req.params.id, { inUse: (file) => repo.mediaInUse(file) });
      req.flash(result.error ? 'danger' : 'success', result.error
        ?? `حُذف «${result.removed.title}» من المكتبة.`);
      res.redirect('/admin/audio');
    } catch (error) {
      next(error);
    }
  });
}
