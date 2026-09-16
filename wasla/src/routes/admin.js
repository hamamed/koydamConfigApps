import express from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';

import { config } from '../config.js';
import { db } from '../db/index.js';
import { csrfProtect, csrfToken, requireAuth, verifyCredentials } from '../middleware/auth.js';
import { cellsOf } from '../layout.js';
import { PACK_COLORS } from '../packs.js';
import { MAX_EMOJI, QUESTION_TYPES } from '../question-types.js';
import { DIFFICULTIES, MAX_ZOOM } from '../repository.js';
import { registerDaily } from './admin-daily.js';
import { registerImport } from './admin-import.js';
import { registerPacks } from './admin-packs.js';
import { registerSettings } from './admin-settings.js';
import { registerStats } from './admin-stats.js';

const megabytes = (bytes) => Math.round(bytes / 1024 / 1024) || 1;

/**
 * The panel: questions (with pictures, sounds and zoom), levels built from
 * them, and the sections registered from the admin-*.js files beside this one.
 */
export function adminRouter({ repo, images, audio, daily, appConfig, events, pendingImports }) {
  const router = express.Router();

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    message: 'Too many sign-in attempts. Try again in a few minutes.',
  });

  // One picture and one sound per question, held in memory so each store can
  // check the bytes before anything touches the disk. The multer cap is the
  // larger of the two; each store then applies its own.
  const uploadMedia = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: Math.max(config.maxImageBytes, config.maxAudioBytes), files: 2 },
  }).fields([{ name: 'image', maxCount: 1 }, { name: 'audio', maxCount: 1 }]);

  /** Multipart forms are parsed first, then CSRF-checked; errors become a flash. */
  const withUpload = (back) => (req, res, next) => uploadMedia(req, res, (err) => {
    if (err) {
      req.flash('danger', err.code === 'LIMIT_FILE_SIZE'
        ? `That file is larger than ${megabytes(Math.max(config.maxImageBytes, config.maxAudioBytes))} MB.`
        : 'That upload could not be read.');
      return res.redirect(back(req));
    }
    return csrfProtect(req, res, next);
  });

  router.use(csrfToken);
  router.use((req, res, next) => (req.is('multipart/*') ? next() : csrfProtect(req, res, next)));
  router.use((req, res, next) => {
    res.locals.currentPath = req.path;
    res.locals.assetVersion = config.assetVersion;
    res.locals.imageUrl = (file) => `/media/questions/${file}`;
    res.locals.audioUrl = (file) => `/media/audio/${file}`;
    next();
  });

  // ── Sign in ───────────────────────────────────────────────────────────────

  router.get('/login', (req, res) => {
    if (req.user) return res.redirect('/admin');
    res.render('login', { title: 'Sign in', platformUrl: config.platformUrl });
  });

  router.post('/login', loginLimiter, (req, res) => {
    const user = verifyCredentials(String(req.body?.username ?? ''), String(req.body?.password ?? ''));
    if (!user) {
      req.flash('danger', 'That username and password did not match.');
      return res.redirect('/admin/login');
    }
    req.session.userId = user.id;
    db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
    res.redirect('/admin');
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/admin/login'));
  });

  router.use(requireAuth);

  // ── Dashboard ─────────────────────────────────────────────────────────────

  router.get('/', (_req, res) => {
    res.render('dashboard', { title: 'Dashboard', counts: repo.counts(), levels: repo.listLevels().slice(0, 8) });
  });

  // ── Questions ─────────────────────────────────────────────────────────────

  router.get('/questions', (req, res) => {
    const search = String(req.query.q ?? '');
    const unused = req.query.unused === '1';
    res.render('questions', { title: 'Questions', questions: repo.listQuestions({ search, unused }), search, unused });
  });

  const blankQuestion = {
    answer: '', playAnswer: '', clue: '', category: '', type: 'text', emoji: '',
    imageFile: null, zoom: 1, focusX: 0.5, focusY: 0.5, blurred: false, audioFile: null,
  };

  const renderForm = (res, question, extra = {}) => res.render('question-form', {
    title: question.id ? 'Edit question' : 'New question',
    question,
    maxZoom: MAX_ZOOM,
    maxEmoji: MAX_EMOJI,
    types: QUESTION_TYPES,
    maxImageMb: megabytes(config.maxImageBytes),
    maxAudioMb: megabytes(config.maxAudioBytes),
    levels: question.id ? repo.levelsUsing(question.id) : [],
    levelId: extra.levelId ?? '',
    categories: [...new Set(repo.listQuestions().map((q) => q.category).filter(Boolean))].sort(),
  });

  router.get('/questions/new', (req, res) => renderForm(res, blankQuestion, { levelId: req.query.level }));

  router.get('/questions/:id', (req, res, next) => {
    const question = repo.getQuestion(Number(req.params.id));
    if (!question) return next();
    renderForm(res, question);
  });

  /**
   * Reads the form, storing a new picture or sound first when one was chosen.
   * On an error, anything it stored is already removed again.
   */
  async function readForm(req) {
    const input = {
      answer: req.body.answer,
      clue: req.body.clue,
      category: req.body.category,
      // Empty is "Automatic": the type follows the media.
      type: req.body.type ?? '',
      emoji: req.body.emoji ?? '',
      zoom: req.body.zoom,
      focusX: req.body.focusX,
      focusY: req.body.focusY,
      blurred: req.body.blurred === '1',
    };

    const picture = req.files?.image?.[0];
    if (picture?.buffer?.length) {
      const saved = await images.save(picture.buffer);
      if (saved.error) return { error: saved.error };
      input.imageFile = saved.file;
    } else if (req.body.removeImage === '1') {
      input.imageFile = null;
      input.zoom = 1;
    }

    const sound = req.files?.audio?.[0];
    if (sound?.buffer?.length) {
      const saved = await audio.save(sound.buffer);
      if (saved.error) {
        await discardNew(input);
        return { error: saved.error };
      }
      input.audioFile = saved.file;
    } else if (req.body.removeAudio === '1') {
      input.audioFile = null;
    }
    return { input };
  }

  /** Removes files a failed save had just stored. */
  async function discardNew(input) {
    if (input?.imageFile) await images.remove(input.imageFile);
    if (input?.audioFile) await audio.remove(input.audioFile);
  }

  /** "Saved “أسد” — played as اسد." when folding changed the letters. */
  const savedMessage = (question) => (question.playAnswer !== question.answer
    ? `Saved “${question.answer}” — played in the grid as “${question.playAnswer}”.`
    : `Saved “${question.answer}”.`);

  router.post('/questions', withUpload(() => '/admin/questions/new'), async (req, res, next) => {
    try {
      const { input, error } = await readForm(req);
      const result = error ? { error } : repo.createQuestion(input);
      if (result.error) {
        await discardNew(input);
        req.flash('danger', result.error);
        return res.redirect(`/admin/questions/new${req.body.level ? `?level=${Number(req.body.level)}` : ''}`);
      }

      const levelId = Number(req.body.level);
      const level = levelId ? repo.getLevel(levelId) : null;
      if (level) {
        const ids = [...level.words, ...level.unplaced].map((w) => w.id);
        repo.setLevelQuestions(level.id, [...ids, result.question.id]);
        req.flash('success', `Added “${result.question.answer}” to ${level.title}.`);
        return res.redirect(`/admin/levels/${level.id}`);
      }
      req.flash('success', savedMessage(result.question));
      res.redirect('/admin/questions');
    } catch (err) {
      next(err);
    }
  });

  router.post('/questions/:id', withUpload((req) => `/admin/questions/${Number(req.params.id)}`), async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const { input, error } = await readForm(req);
      const result = error ? { error } : repo.updateQuestion(id, input);
      if (result.error) {
        await discardNew(input);
        req.flash('danger', result.error);
        return res.redirect(`/admin/questions/${id}`);
      }
      if (result.previousImage && result.previousImage !== result.question.imageFile) {
        await images.remove(result.previousImage);
      }
      if (result.previousAudio && result.previousAudio !== result.question.audioFile) {
        await audio.remove(result.previousAudio);
      }
      req.flash(result.unpublished.length ? 'warning' : 'success', result.unpublished.length
        ? `Saved. The new answer no longer crosses the grid, so these levels were unpublished: ${result.unpublished.join('، ')}.`
        : savedMessage(result.question));
      res.redirect('/admin/questions');
    } catch (err) {
      next(err);
    }
  });

  router.post('/questions/:id/delete', async (req, res, next) => {
    try {
      const result = repo.deleteQuestion(Number(req.params.id));
      if (result.error) {
        req.flash('danger', result.error);
        return res.redirect(`/admin/questions/${Number(req.params.id)}`);
      }
      await images.remove(result.imageFile);
      await audio.remove(result.audioFile);
      req.flash('success', 'Question deleted.');
      res.redirect('/admin/questions');
    } catch (err) {
      next(err);
    }
  });

  // ── Levels ────────────────────────────────────────────────────────────────

  router.get('/levels', (_req, res) => {
    res.render('levels', { title: 'Levels', levels: repo.listLevels(), packColors: PACK_COLORS });
  });

  router.post('/levels/order-by-difficulty', (req, res) => {
    const moved = repo.orderByDifficulty();
    req.flash('success', moved
      ? `Reordered: ${moved} level(s) moved. Inside each pack, easy levels come first, then fewer words.`
      : 'Already in order — nothing moved.');
    res.redirect('/admin/levels');
  });

  router.post('/levels', (req, res) => {
    const level = repo.createLevel(req.body.title);
    req.flash('success', `Created ${level.title}. Pick its questions below.`);
    res.redirect(`/admin/levels/${level.id}`);
  });

  router.get('/levels/:id', (req, res, next) => {
    const level = repo.getLevel(Number(req.params.id));
    if (!level) return next();
    const cells = new Map();
    // The played letters, as the app draws them.
    level.words.forEach((word, i) => cellsOf({ ...word, answer: word.playAnswer }).forEach((cell, k) => {
      const key = `${cell.row},${cell.col}`;
      const existing = cells.get(key) ?? { ...cell, starts: [] };
      if (k === 0) existing.starts.push(i + 1);
      cells.set(key, existing);
    }));
    const chosen = new Set([...level.words, ...level.unplaced].map((w) => w.id));
    res.render('level', {
      title: level.title,
      level,
      cells: [...cells.values()],
      questions: repo.listQuestions(),
      packs: repo.listPacks(),
      difficulties: DIFFICULTIES,
      chosen,
      number: level.published ? repo.listLevels().filter((l) => l.published).findIndex((l) => l.id === level.id) + 1 : null,
    });
  });

  const levelAction = (path, handler) => router.post(`/levels/:id/${path}`, (req, res) => {
    const id = Number(req.params.id);
    if (!repo.getLevel(id)) {
      req.flash('danger', 'That level no longer exists.');
      return res.redirect('/admin/levels');
    }
    const back = handler(id, req) ?? `/admin/levels/${id}`;
    res.redirect(back);
  });

  levelAction('title', (id, req) => {
    const result = repo.renameLevel(id, req.body.title);
    req.flash(result.error ? 'danger' : 'success', result.error ?? 'Title saved.');
  });

  levelAction('details', (id, req) => {
    const result = repo.setLevelDetails(id, { packId: req.body.packId, difficulty: req.body.difficulty });
    req.flash(result.error ? 'danger' : 'success', result.error ?? 'Pack and difficulty saved.');
  });

  levelAction('words', (id, req) => {
    const raw = req.body.questions;
    const ids = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const { layout, unpublished } = repo.setLevelQuestions(id, ids);
    if (unpublished) req.flash('warning', 'Saved, and unpublished: the grid can no longer be published as it is.');
    else if (layout.unplaced.length) req.flash('warning', `Saved. ${layout.unplaced.length} word(s) do not cross the others yet.`);
    else req.flash('success', `Grid built from ${layout.placements.length} words.`);
  });

  levelAction('shuffle', (id, req) => {
    repo.shuffleLevel(id);
    req.flash('success', 'Shuffled — a new arrangement of the same words.');
  });

  levelAction('publish', (id, req) => {
    const on = req.body.published === '1';
    const result = repo.setPublished(id, on);
    req.flash(result.error ? 'danger' : 'success', result.error ?? (on ? 'Published — it is in the app now.' : 'Unpublished.'));
  });

  levelAction('move', (id, req) => {
    repo.moveLevel(id, req.body.direction === 'up' ? 'up' : 'down');
    return '/admin/levels';
  });

  levelAction('delete', (id, req) => {
    repo.deleteLevel(id);
    req.flash('success', 'Level deleted. Its questions are still in the question bank.');
    return '/admin/levels';
  });

  registerPacks(router, { repo });
  registerDaily(router, { repo, daily });
  registerStats(router, { events });
  registerImport(router, { repo, images, audio, pendingImports });
  registerSettings(router, { appConfig });

  return router;
}
