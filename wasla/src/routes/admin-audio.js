import multer from 'multer';

import {
  clockText, LICENCES, MAX_CATEGORY, MAX_SECONDS, MAX_TITLE, MIN_SECONDS, readTime,
} from '../audio-clips.js';
import { CC_BY, CC_BY_NAME } from '../audio-import.js';
import { config } from '../config.js';

/**
 * The sound library: upload a sound, cut the piece you want out of it, and keep
 * that piece in a category, with what licence lets it be played. A clip in the
 * library can be turned into a question in one click, which opens the question
 * form with the sound already chosen and in the clip's own category.
 *
 * A clip can also be brought in from a YouTube video — but only one its
 * uploader licensed Creative Commons Attribution, which is the licence that
 * lets it be shipped inside the app. Every other video is refused, and the
 * refusal says which licence was found.
 */
export function registerAudio(router, { audioClips, repo, titleNames, audioImport = null }) {
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
    canImport: Boolean(audioImport),
    ccBy: CC_BY,
    youtube: { url: '', start: '0:00', seconds: '8', category: '', title: '' },
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

  /** «افحص»: what the video is and whether its licence lets it be used. */
  router.post('/audio/youtube/check', async (req, res, next) => {
    if (!audioImport) return res.redirect('/admin/audio');
    try {
      const found = await audioImport.probe(req.body.url);
      if (found.error) {
        req.flash('danger', found.error);
        return res.redirect('/admin/audio');
      }
      const refusal = audioImport.usable(found.video);
      req.flash(refusal.error ? 'danger' : 'success', refusal.error
        ?? `«${found.video.title}» — ${found.video.channel} · ${clockText(found.video.seconds)} · صالح للاستعمال (${CC_BY_NAME}).`);
      res.redirect('/admin/audio');
    } catch (error) {
      next(error);
    }
  });

  /** Fetches the asked-for seconds of a CC-BY video and keeps them as a clip. */
  router.post('/audio/youtube', async (req, res, next) => {
    if (!audioImport) return res.redirect('/admin/audio');
    try {
      const seconds = Number(req.body.seconds);
      if (!Number.isFinite(seconds) || seconds < MIN_SECONDS || seconds > MAX_SECONDS) {
        req.flash('danger', `مدة المقطع من ${MIN_SECONDS} إلى ${MAX_SECONDS} ثانية.`);
        return res.redirect('/admin/audio');
      }
      const start = readTime(req.body.start);
      if (start === null) {
        req.flash('danger', 'بداية القص غير صحيحة؛ اكتبها ثوانٍ أو د:ث.');
        return res.redirect('/admin/audio');
      }
      const got = await audioImport.clip(req.body.url, { start, seconds });
      if (got.error) {
        req.flash('danger', got.error);
        return res.redirect('/admin/audio');
      }
      // The clip goes through the same door an uploaded one does, so it is cut,
      // checked and stored exactly the same way.
      const saved = await audioClips.save(got.audio, {
        title: String(req.body.title ?? '').trim() || got.video.title,
        category: req.body.category,
        start: 0,
        seconds,
        source: got.video.url,
        licence: CC_BY_NAME,
        author: got.video.channel,
      });
      if (saved.error) {
        req.flash('danger', saved.error);
        return res.redirect('/admin/audio');
      }
      req.flash('success', `حُفظ «${saved.clip.title}» من يوتيوب — ${clockText(saved.clip.seconds)} · ${CC_BY_NAME} · ${saved.clip.author}.`);
      res.redirect('/admin/audio');
    } catch (error) {
      next(error);
    }
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
