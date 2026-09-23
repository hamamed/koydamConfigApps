import multer from 'multer';

import { clockText, LICENCES, MAX_SECONDS, MAX_TITLE, MIN_SECONDS } from '../audio-clips.js';
import { config } from '../config.js';

/**
 * The sound library: upload a sound, cut the piece you want out of it, and keep
 * that piece with what licence lets it be played. A clip in the library can be
 * turned into a question in one click, which opens the question form with the
 * sound already chosen.
 *
 * Nothing here downloads audio from anywhere — a clip is cut from a file you
 * hand the panel, and every clip carries where it came from.
 */
export function registerAudio(router, { audioClips, repo }) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxAudioBytes } })
    .single('sound');

  const page = (res, extra = {}) => res.render('audio', {
    title: 'مكتبة الأصوات',
    clips: audioClips.list().map((c) => ({ ...c, length: clockText(c.seconds) })),
    licences: LICENCES,
    maxTitle: MAX_TITLE,
    minSeconds: MIN_SECONDS,
    maxSeconds: MAX_SECONDS,
    maxMb: Math.round(config.maxAudioBytes / 1024 / 1024) || 1,
    draft: { title: '', start: '0:00', seconds: '8', source: '', licence: '', author: '' },
    ...extra,
  });

  router.get('/audio', (_req, res) => page(res));

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
        req.flash('success', `حُفظ «${result.clip.title}» — ${clockText(result.clip.seconds)}.`);
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
