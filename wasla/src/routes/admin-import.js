import rateLimit from 'express-rate-limit';
import multer from 'multer';

import { sniffAudio } from '../audio.js';
import { config } from '../config.js';
import { sniffImage } from '../images.js';
import {
  commitImport, EDITABLE_COLUMNS, editImportRows, IMPORT_COLUMNS, MAX_IMPORT_ROWS, planImport, readImportCsv,
} from '../importer.js';
import { csrfProtect } from '../middleware/auth.js';
import { MAX_PASTE_CHARS, PASTE_ORDERS, readPastedQuestions } from '../paste-import.js';

export const MAX_IMPORT_MEDIA = 100;
const MAX_CSV_BYTES = 2 * 1024 * 1024;

/**
 * multer 1.x decodes multipart file names as Latin-1, so an Arabic name
 * arrives as mojibake. Browsers send UTF-8; re-reading the bytes restores it.
 */
const decodeName = (name) => {
  const utf8 = Buffer.from(String(name ?? ''), 'latin1').toString('utf8');
  return utf8.includes('�') ? String(name ?? '') : utf8;
};

/** Bulk import: upload a CSV with media → preview → confirm or cancel. */
export function registerImport(router, { repo, images, audio, pendingImports }) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: Math.max(config.maxImageBytes, config.maxAudioBytes, MAX_CSV_BYTES),
      files: MAX_IMPORT_MEDIA + 1,
    },
  }).fields([{ name: 'csv', maxCount: 1 }, { name: 'media', maxCount: MAX_IMPORT_MEDIA }]);

  // Uploads are held in memory while their bytes are checked, so a batch can be
  // a couple of hundred megabytes. One at a time, and not too many in a row,
  // keeps a burst of imports from exhausting a box other services share.
  let importing = false;
  const importLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      req.flash('danger', 'Too many imports in a short time. Wait a few minutes and try again.');
      res.redirect('/admin/import');
    },
  });

  const oneAtATime = (req, res, next) => {
    if (importing) {
      req.flash('warning', 'Another import is still uploading. Try again when it has finished.');
      return res.redirect('/admin/import');
    }
    importing = true;
    let released = false;
    const release = () => {
      if (!released) { released = true; importing = false; }
    };
    res.on('finish', release);
    res.on('close', release);
    return next();
  };

  const withUpload = (req, res, next) => upload(req, res, (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'One of the files is larger than the limit for its kind.'
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `At most ${MAX_IMPORT_MEDIA} media files per import.`
          : 'That upload could not be read.';
      req.flash('danger', message);
      return res.redirect('/admin/import');
    }
    return csrfProtect(req, res, next);
  });

  /** Stores each uploaded file in the store its bytes belong to. */
  async function storeMedia(files) {
    const media = [];
    const fileErrors = [];
    const seen = new Set();
    for (const upload of files) {
      const name = decodeName(upload.originalname);
      const key = name.toLowerCase();
      if (seen.has(key)) {
        fileErrors.push({ name, error: 'Two files have this name; only the first was kept.' });
        continue;
      }
      seen.add(key);
      const kind = sniffImage(upload.buffer) ? 'image' : sniffAudio(upload.buffer) ? 'audio' : null;
      if (!kind) {
        fileErrors.push({ name, error: 'Not a PNG, JPEG or WebP picture, nor an MP3, M4A, AAC or WAV sound.' });
        continue;
      }
      const saved = await (kind === 'image' ? images : audio).save(upload.buffer);
      if (saved.error) fileErrors.push({ name, error: saved.error });
      else media.push({ name, kind, file: saved.file });
    }
    return { media, fileErrors };
  }

  const mediaMap = (media) => new Map(media.map((m) => [m.name.toLowerCase(), m]));

  /** Removes stored files that no question ended up using. */
  async function discardUnused(media) {
    for (const m of media) {
      if (!repo.mediaInUse(m.file)) await (m.kind === 'audio' ? audio : images).remove(m.file);
    }
  }

  router.get('/import', (_req, res) => {
    res.render('import', {
      title: 'Import',
      columns: IMPORT_COLUMNS,
      maxMedia: MAX_IMPORT_MEDIA,
      maxPaste: MAX_PASTE_CHARS,
      orders: PASTE_ORDERS,
      titles: [...new Set(repo.listQuestions().map((q) => q.title).filter(Boolean))].sort(),
      levelCount: repo.listLevels().length,
    });
  });

  // Text copied from a website or a document. Sent as multipart, because a long
  // Arabic paste, percent-encoded, is larger than the panel's form-body limit.
  const pasteForm = multer({ limits: { fieldSize: MAX_PASTE_CHARS * 4, fields: 10 } }).none();
  const withPaste = (req, res, next) => pasteForm(req, res, (err) => {
    if (err) {
      req.flash('danger', 'That text is too long for one import. Split it.');
      return res.redirect('/admin/import');
    }
    return csrfProtect(req, res, next);
  });

  router.post('/import/paste', importLimiter, withPaste, (req, res) => {
    const parsed = readPastedQuestions(req.body.text, { title: req.body.title, level: req.body.level, order: req.body.order });
    if (parsed.error) {
      req.flash('danger', parsed.error);
      return res.redirect('/admin/import');
    }
    const id = pendingImports.save({ fileName: 'Pasted text', rows: parsed.rows, media: [], fileErrors: [] });
    res.redirect(`/admin/import/${id}`);
  });

  router.post('/import', importLimiter, oneAtATime, withUpload, async (req, res, next) => {
    try {
      const csv = req.files?.csv?.[0];
      if (!csv?.buffer?.length) {
        req.flash('danger', 'Choose a CSV file to import.');
        return res.redirect('/admin/import');
      }
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(csv.buffer);
      } catch {
        req.flash('danger', 'The CSV is not UTF-8. Save it again as “CSV UTF-8” and upload that.');
        return res.redirect('/admin/import');
      }
      const parsed = readImportCsv(text);
      if (parsed.error) {
        req.flash('danger', parsed.error);
        return res.redirect('/admin/import');
      }

      const { media, fileErrors } = await storeMedia(req.files?.media ?? []);
      const id = pendingImports.save({ fileName: decodeName(csv.originalname), rows: parsed.rows, media, fileErrors });
      res.redirect(`/admin/import/${id}`);
    } catch (err) {
      next(err);
    }
  });

  router.get('/import/:id', (req, res, next) => {
    const payload = pendingImports.get(req.params.id);
    if (!payload) return next();
    // Checked again on every view: a level may have changed since the upload.
    const plan = planImport(repo, payload.rows, mediaMap(payload.media));
    const named = new Set(plan.flatMap((p) => [p.input?.imageFile, p.input?.audioFile]).filter(Boolean));
    res.render('import-preview', {
      // What each row says now, for the fields the admin can change here.
      values: new Map(payload.rows.map(({ row, values }) => [row, { ...values, title: values.title || values.category || '' }])),
      titles: [...new Set(repo.listQuestions().map((q) => q.title).filter(Boolean))].sort(),
      title: 'Import preview',
      id: req.params.id,
      fileName: payload.fileName,
      plan,
      valid: plan.filter((p) => !p.error).length,
      fileErrors: payload.fileErrors,
      unused: payload.media.filter((m) => !named.has(m.file)),
      mediaCount: payload.media.length,
    });
  });

  /** Imports the pending rows that pass, then reports what happened. */
  async function confirmImport(req, res, next) {
    const payload = pendingImports.get(req.params.id);
    if (!payload) {
      req.flash('danger', 'That import has expired or was already confirmed. Upload it again.');
      return res.redirect('/admin/import');
    }
    try {
      const plan = planImport(repo, payload.rows, mediaMap(payload.media));
      if (!plan.some((p) => !p.error)) {
        req.flash('danger', 'No row is valid, so nothing was imported. Fix the rows and try again.');
        return res.redirect(`/admin/import/${req.params.id}`);
      }
      const result = commitImport(repo, plan);
      pendingImports.remove(req.params.id);
      await discardUnused(payload.media);

      const skipped = plan.length - result.imported;
      const unpublished = result.levels.filter((l) => l.unpublished).map((l) => l.name);
      const notCrossing = result.levels.filter((l) => l.unplaced).map((l) => l.name);
      const parts = [
        `Imported ${result.imported} question(s)${skipped ? `, skipped ${skipped} with errors` : ''}.`,
        result.levels.length ? `Levels updated: ${result.levels.map((l) => `${l.name}${l.created ? ' (new)' : ''}`).join(', ')}.` : '',
        notCrossing.length ? `Some words do not cross yet in: ${notCrossing.join(', ')}.` : '',
        unpublished.length ? `Unpublished because the grid no longer connects: ${unpublished.join(', ')}.` : '',
      ];
      req.flash(unpublished.length || notCrossing.length ? 'warning' : 'success', parts.filter(Boolean).join(' '));
      res.redirect('/admin/import');
    } catch (err) {
      if (err.status === 400) {
        req.flash('danger', `Nothing was imported. ${err.message}`);
        return res.redirect(`/admin/import/${req.params.id}`);
      }
      next(err);
    }
  }

  router.post('/import/:id/confirm', confirmImport);

  // The preview's own edits: change a row's answer, clue, title or level, or drop the row —
  // then look again, or import straight away. Multipart, like the paste, because a long file's
  // fields are larger than the panel's form-body limit.
  const rowsForm = multer({ limits: { fieldSize: 64 * 1024, fields: EDITABLE_COLUMNS.length * MAX_IMPORT_ROWS + 10 } }).none();
  const withRows = (req, res, next) => rowsForm(req, res, (err) => {
    if (err) {
      req.flash('danger', 'Those changes could not be read. Try again.');
      return res.redirect(`/admin/import/${encodeURIComponent(req.params.id)}`);
    }
    return csrfProtect(req, res, next);
  });

  router.post('/import/:id/rows', withRows, async (req, res, next) => {
    const payload = pendingImports.get(req.params.id);
    if (!payload) {
      req.flash('danger', 'That import has expired or was already confirmed. Upload it again.');
      return res.redirect('/admin/import');
    }
    try {
      const edits = new Map();
      for (const [name, value] of Object.entries(req.body ?? {})) {
        const match = /^(answer|clue|title|level)_(\d+)$/.exec(name);
        if (!match || typeof value !== 'string') continue;
        const row = Number(match[2]);
        edits.set(row, { ...edits.get(row), [match[1]]: value });
      }
      const removed = req.body.remove ? [req.body.remove] : [];
      const rows = editImportRows(payload.rows, edits, removed);
      if (!rows.length) {
        pendingImports.remove(req.params.id);
        await discardUnused(payload.media);
        req.flash('warning', 'Every row was removed, so there is nothing left to import.');
        return res.redirect('/admin/import');
      }
      pendingImports.update(req.params.id, { ...payload, rows });
      if (req.body.then === 'confirm') return confirmImport(req, res, next);
      req.flash('success', removed.length ? `Row ${removed[0]} removed.` : 'Changes saved.');
      res.redirect(`/admin/import/${req.params.id}`);
    } catch (err) {
      next(err);
    }
  });

  router.post('/import/:id/cancel', async (req, res, next) => {
    try {
      const payload = pendingImports.get(req.params.id);
      if (payload) {
        pendingImports.remove(req.params.id);
        await discardUnused(payload.media);
      }
      req.flash('success', 'Import cancelled. Nothing was added.');
      res.redirect('/admin/import');
    } catch (err) {
      next(err);
    }
  });
}
