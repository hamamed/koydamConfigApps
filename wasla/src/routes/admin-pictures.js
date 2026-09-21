import { MAX_ROUND_WORDS, MAX_TITLE, MIN_ROUND_WORDS, WORD_LETTERS } from '../bubble-pictures.js';

/**
 * The pictures فقاعات الكلمات is played on, written here one at a time.
 *
 * Nothing in the question bank says what belongs to a picture, so this is the
 * one game whose content is typed by hand: a picture and the words that belong
 * to it. The game cuts those words into pieces. A round is only played once
 * published, and a round with no picture cannot be published at all.
 */
export function registerBubblePictures(router, { pictures, images, withUpload }) {
  const form = (round = null, draft = {}, errors = []) => ({
    title: round ? `تعديل «${round.title}»` : 'صورة جديدة',
    round,
    draft: {
      title: draft.title ?? round?.title ?? '',
      words: draft.words ?? (round ? round.words.join('\n') : ''),
      zoom: draft.zoom ?? round?.zoom ?? 1,
      focusX: draft.focusX ?? round?.focusX ?? 0.5,
      focusY: draft.focusY ?? round?.focusY ?? 0.5,
    },
    errors,
    limits: { min: MIN_ROUND_WORDS, max: MAX_ROUND_WORDS, letters: WORD_LETTERS, title: MAX_TITLE },
  });

  router.get('/pictures', (_req, res) => {
    const rounds = pictures.all();
    res.render('pictures', {
      title: 'صور فقاعات الكلمات',
      rounds,
      counts: pictures.counts(),
      min: MIN_ROUND_WORDS,
      max: MAX_ROUND_WORDS,
    });
  });

  router.get('/pictures/new', (_req, res) => res.render('picture-form', form()));

  router.get('/pictures/:id', (req, res) => {
    const round = pictures.get(req.params.id);
    if (!round) {
      req.flash('danger', 'لا توجد صورة بهذا الرقم.');
      return res.redirect('/admin/pictures');
    }
    res.render('picture-form', form(round));
  });

  /** New or edited: the picture is optional on save, required before publishing. */
  const save = async (req, res) => {
    const id = req.params.id ? Number(req.params.id) : null;
    const current = id ? pictures.get(id) : null;
    if (id && !current) {
      req.flash('danger', 'لا توجد صورة بهذا الرقم.');
      return res.redirect('/admin/pictures');
    }

    let imageFile = current?.imageFile ?? null;
    const picture = req.files?.image?.[0];
    if (picture?.buffer?.length) {
      const saved = await images.save(picture.buffer);
      if (saved.error) {
        return res.status(400).render('picture-form', form(current, req.body, [saved.error]));
      }
      imageFile = saved.file;
    } else if (req.body.removeImage === '1') {
      imageFile = null;
    }

    const result = pictures.save({ ...req.body, imageFile }, id);
    if (result.errors) {
      return res.status(400).render('picture-form', form(current, req.body, result.errors));
    }
    req.flash('success', id ? 'حُفظت الصورة.' : 'أُضيفت الصورة. انشرها لتُلعب.');
    res.redirect(`/admin/pictures/${result.id}`);
  };

  router.post('/pictures', withUpload(() => '/admin/pictures/new'), save);
  router.post('/pictures/:id', withUpload((req) => `/admin/pictures/${req.params.id}`), save);

  router.post('/pictures/:id/published', (req, res) => {
    const { error } = pictures.setPublished(req.params.id, req.body.published === '1');
    req.flash(error ? 'danger' : 'success', error ?? (req.body.published === '1' ? 'نُشرت الصورة.' : 'أُخفيت الصورة.'));
    res.redirect('/admin/pictures');
  });

  router.post('/pictures/:id/delete', (req, res) => {
    const gone = pictures.remove(req.params.id);
    req.flash(gone ? 'success' : 'danger', gone ? 'حُذفت الصورة.' : 'لا توجد صورة بهذا الرقم.');
    res.redirect('/admin/pictures');
  });
}
