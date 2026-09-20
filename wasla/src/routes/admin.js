import path from 'node:path';

import express from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';

import { config } from '../config.js';
import { db } from '../db/index.js';
import { csrfProtect, csrfToken, requireAuth, verifyCredentials } from '../middleware/auth.js';
import { cellsOf } from '../layout.js';
import { LEVEL_SIZE, MAIN_CATEGORY, MAIN_SLOTS, MIN_CATEGORIES, planLevels } from '../level-builder.js';
import { imageSize } from '../image-size.js';
import { MAX_EMOJI, QUESTION_TYPES } from '../question-types.js';
import { previewLevel, previewQuestion, STARTING_COINS } from '../preview.js';
import { DIFFICULTIES, MAX_TITLE, MAX_ZOOM, truthy } from '../repository.js';
import { registerDaily } from './admin-daily.js';
import { registerDailyGames } from './admin-daily-games.js';
import { registerDays } from './admin-days.js';
import { registerImport } from './admin-import.js';
import { registerNotifications } from './admin-notifications.js';
import { registerPlayers } from './admin-players.js';
import { registerProfiles } from './admin-profiles.js';
import { registerSettings } from './admin-settings.js';
import { registerStats } from './admin-stats.js';
import { registerTitles } from './admin-titles.js';
import { registerWordSearch } from './admin-wordsearch.js';

const megabytes = (bytes) => Math.round(bytes / 1024 / 1024) || 1;

/** Levels one run of the generator may build, and the words one level may hold. */
const MAX_GENERATED = 60;
/** Above this the layout stops beam-searching, and the grids come out as chains. */
const MAX_LEVEL_SIZE = 14;

/** `total` split as evenly as possible into `parts`, the earlier parts taking the remainder. */
function share(total, parts) {
  return Array.from({ length: parts }, (_, i) => Math.floor(total / parts) + (i < total % parts ? 1 : 0));
}

/**
 * The panel: questions (with pictures, sounds and zoom), levels built from
 * them, and the sections registered from the admin-*.js files beside this one.
 */
export function adminRouter({
  repo, images, audio, appConfig, events, pendingImports, siteSettings, devices, notifications, apnsCredentials, players, wordSearch, wordSearchDays, dailyGames, profiles, titles = null,
}) {
  const router = express.Router();

  /**
   * A stored picture's pixel size, so a preview frames it the way the app does.
   * Only a plain file name is looked up, never a path out of the pictures folder.
   */
  const pictureSize = (file) => (file && !/[\\/]/.test(file) && !file.startsWith('.')
    ? imageSize(path.join(images.root, file))
    : null);

  /** The titles every title box offers: the Titles list, or (without it) those on questions. */
  const titleNames = () => (titles ? titles.names()
    : [...new Set(repo.listQuestions().map((q) => q.title).filter(Boolean))].sort());

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

  /** `?title=*` shows every category at once. */
  const ALL_TITLES = '*';

  router.get('/questions', (req, res) => {
    const search = String(req.query.q ?? '');
    const unused = req.query.unused === '1';
    // The categories (titles) with how many questions each has, biggest first.
    const counts = new Map();
    for (const q of repo.listQuestions()) counts.set(q.title || '', (counts.get(q.title || '') ?? 0) + 1);
    const categories = [...counts].filter(([name]) => name)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ar'));
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    // One category at a time: the first one, unless a search, "all" or another category was asked for.
    const asked = String(req.query.title ?? '').trim();
    const showAll = asked === ALL_TITLES || (!asked && (search || unused));
    const titleFilter = showAll ? '' : (asked || categories[0]?.name || '');
    res.render('questions', {
      title: 'Questions',
      categories,
      total,
      allTitles: ALL_TITLES,
      showAll,
      questions: repo.listQuestions({ search, unused, title: titleFilter }),
      search,
      unused,
      levels: repo.listLevels(),
      titles: titleNames(),
      titleFilter,
    });
  });

  // Many questions at once, from the checkboxes on the list: delete, retitle, move or take out of levels.
  router.post('/questions/bulk', async (req, res, next) => {
    const params = new URLSearchParams();
    if (req.body.q) params.set('q', String(req.body.q));
    if (req.body.unused === '1') params.set('unused', '1');
    if (req.body.titleFilter) params.set('title', String(req.body.titleFilter));
    if (req.body.showAll === '1') params.set('title', ALL_TITLES);
    const back = `/admin/questions${params.size ? `?${params}` : ''}`;
    const ids = req.body.ids ?? [];
    if (!(Array.isArray(ids) ? ids.length : ids)) {
      req.flash('warning', 'Select at least one question first.');
      return res.redirect(back);
    }
    const unpublishedNote = (names) => (names.length ? ` Unpublished (no longer publishable): ${names.join(', ')}.` : '');
    try {
      switch (req.body.action) {
        case 'delete': {
          const { deleted, kept, files } = repo.deleteQuestions(ids);
          for (const file of files) {
            if (!repo.mediaInUse(file)) {
              await images.remove(file);
              await audio.remove(file);
            }
          }
          req.flash(deleted ? 'success' : 'warning', `Deleted ${deleted} question(s).`
            + (kept ? ` ${kept} kept because they are in a level — remove them from their level first.` : ''));
          break;
        }
        case 'title': {
          const result = repo.setQuestionsTitle(ids, req.body.title);
          req.flash(result.error ? 'danger' : 'success', result.error ?? `Title set on ${result.updated} question(s).`);
          break;
        }
        case 'move':
        case 'new-level': {
          const result = req.body.action === 'move' ? repo.moveQuestionsToLevel(ids, req.body.level) : repo.newLevelFromQuestions(ids);
          if (result.error) {
            req.flash('danger', result.error);
            break;
          }
          const loose = result.unplaced ? ` ${result.unplaced} word(s) do not cross the others yet.` : '';
          req.flash(result.unplaced || result.unpublished.length ? 'warning' : 'success',
            `Moved ${result.moved} question(s) to ${result.level.name}.${loose}${unpublishedNote(result.unpublished)}`);
          if (req.body.action === 'new-level') return res.redirect(`/admin/levels/${result.level.id}`);
          break;
        }
        case 'remove': {
          const result = repo.removeQuestionsFromLevels(ids);
          req.flash('success', `Took ${result.removed} question(s) out of their levels.${unpublishedNote(result.unpublished)}`);
          break;
        }
        default:
          req.flash('warning', 'Choose what to do with the selected questions.');
      }
      res.redirect(back);
    } catch (err) {
      next(err);
    }
  });

  const blankQuestion = {
    answer: '', playAnswer: '', clue: '', title: '', type: 'text', emoji: '',
    imageFile: null, zoom: 1, focusX: 0.5, focusY: 0.5, blurred: false, audioFile: null,
    imageAuthor: '', imageLicence: '', imageSource: '', difficulty: '',
  };

  const renderForm = (res, question, extra = {}) => res.render('question-form', {
    title: question.id ? 'Edit question' : 'New question',
    question,
    maxZoom: MAX_ZOOM,
    maxTitle: MAX_TITLE,
    maxEmoji: MAX_EMOJI,
    types: QUESTION_TYPES,
    maxImageMb: megabytes(config.maxImageBytes),
    maxAudioMb: megabytes(config.maxAudioBytes),
    levels: question.id ? repo.levelsUsing(question.id) : [],
    levelId: extra.levelId ?? '',
    // Titles already in use, offered for reuse.
    titles: titleNames(),
  });

  // `?title=حيوانات` (from the Titles page) starts the new question with that title.
  router.get('/questions/new', (req, res) => renderForm(res, { ...blankQuestion, title: String(req.query.title ?? '').trim().slice(0, 40) },
    { levelId: req.query.level }));

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
      title: req.body.title,
      // Empty is "Automatic": the type follows the media.
      type: req.body.type ?? '',
      emoji: req.body.emoji ?? '',
      zoom: req.body.zoom,
      focusX: req.body.focusX,
      focusY: req.body.focusY,
      blurred: req.body.blurred === '1',
      difficulty: req.body.difficulty ?? '',
      imageAuthor: req.body.imageAuthor ?? '',
      imageLicence: req.body.imageLicence ?? '',
      imageSource: req.body.imageSource ?? '',
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
        req.flash('success', `Added “${result.question.answer}” to ${level.name}.`);
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
        ? `Saved. The new answer no longer crosses the grid, so these levels were unpublished: ${result.unpublished.join(', ')}.`
        : savedMessage(result.question));
      res.redirect('/admin/questions');
    } catch (err) {
      next(err);
    }
  });

  /** Where to go back to after a row action: a questions-list address, never anything else. */
  const listAddress = (raw) => {
    const text = String(raw ?? '');
    return /^\/admin\/questions(\?[^\s]*)?$/.test(text) ? text : '/admin/questions';
  };

  // A picture straight from the questions list, for questions created ahead of their picture.
  router.post('/questions/:id/picture', withUpload((req) => listAddress(req.body?.back)), async (req, res, next) => {
    const back = listAddress(req.body.back);
    try {
      const id = Number(req.params.id);
      const picture = req.files?.image?.[0];
      if (!picture?.buffer?.length) {
        req.flash('warning', 'Choose a picture first.');
        return res.redirect(back);
      }
      const saved = await images.save(picture.buffer);
      if (saved.error) {
        req.flash('danger', saved.error);
        return res.redirect(back);
      }
      const result = repo.updateQuestion(id, { imageFile: saved.file, type: 'image' });
      if (result.error) {
        await images.remove(saved.file);
        req.flash('danger', result.error);
        return res.redirect(back);
      }
      if (result.previousImage && result.previousImage !== saved.file && !repo.mediaInUse(result.previousImage)) {
        await images.remove(result.previousImage);
      }
      req.flash('success', `Picture added to «${result.question.answer}».`);
      res.redirect(back);
    } catch (err) {
      next(err);
    }
  });

  // The question as the player sees it, on a phone-sized screen.
  router.get('/questions/:id/preview', (req, res, next) => {
    const question = repo.getQuestion(Number(req.params.id));
    if (!question) return next();
    res.render('question-preview', {
      title: `Preview · ${question.answer}`,
      question,
      preview: previewQuestion(question, { pictureSize }),
      coins: STARTING_COINS,
      levels: repo.levelsUsing(question.id),
    });
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

  /** The free questions (in no level, picture in hand) each category can still give a level. */
  const freeQuestions = () => repo.listQuestions({ unused: true }).filter((q) => q.title && !q.needsPicture);

  /** The words the levels already hold, so a generated level does not repeat one. */
  const usedAnswers = () => repo.listQuestions().filter((q) => q.levelCount > 0).map((q) => q.playAnswer);

  router.get('/levels', (_req, res) => {
    const free = freeQuestions();
    const counts = new Map();
    free.forEach((q) => {
      const row = counts.get(q.title) ?? { name: q.title, total: 0, easy: 0, medium: 0, hard: 0 };
      row.total += 1;
      if (DIFFICULTIES.includes(q.difficulty)) row[q.difficulty] += 1;
      counts.set(q.title, row);
    });
    res.render('levels', {
      title: 'Levels',
      levels: repo.listLevels(),
      categories: [...counts.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'ar')),
      difficulties: DIFFICULTIES,
      minCategories: MIN_CATEGORIES,
      levelSize: LEVEL_SIZE,
      maxLevelSize: MAX_LEVEL_SIZE,
      maxGenerated: MAX_GENERATED,
      mainCategory: MAIN_CATEGORY,
      mainSlots: MAIN_SLOTS,
    });
  });

  /**
   * Builds levels on their own: ten questions each, from categories the generator
   * draws at random with معلومات عامة taking two of the ten, only from questions no
   * level uses, and only sets whose words cross.
   *
   * With no difficulty picked the run is a spread — easy levels first, then medium,
   * then hard — and each level is tagged with the difficulty its questions came from,
   * which is the order players meet them in.
   */
  router.post('/levels/generate', (req, res) => {
    const chosen = [].concat(req.body.categories ?? []).map((name) => String(name).trim()).filter(Boolean);
    const difficulty = String(req.body.difficulty ?? '').trim();
    const count = Math.min(MAX_GENERATED, Math.max(1, Math.round(Number(req.body.count)) || 1));
    const size = Math.min(MAX_LEVEL_SIZE, Math.max(MIN_CATEGORIES, Math.round(Number(req.body.size)) || LEVEL_SIZE));
    const publish = truthy(req.body.publish);
    if (difficulty && !DIFFICULTIES.includes(difficulty)) {
      req.flash('danger', `The difficulty is one of: ${DIFFICULTIES.join(', ')}.`);
      return res.redirect('/admin/levels');
    }

    const free = freeQuestions();
    const wanted = difficulty ? [difficulty] : DIFFICULTIES;
    const taken = usedAnswers();
    const planned = [];
    let ranOutOf = null;
    let ranOut = false;
    let noCrossing = false;
    let error = null;

    // Each difficulty is planned on its own so a level's words are all of one grade;
    // the words already spent carry from one round to the next, so none is used twice.
    share(count, wanted.length).forEach((want, at) => {
      if (!want || error) return;
      const grade = wanted[at];
      const plan = planLevels({
        questions: free.filter((q) => q.difficulty === grade),
        categories: chosen,
        count: want,
        size,
        seed: (Date.now() + at) % 1000000,
        usedAnswers: taken,
      });
      if (plan.error) { error = plan.error; return; }
      plan.levels.forEach((words) => {
        words.forEach((word) => taken.push(word.playAnswer));
        planned.push({ words, difficulty: grade });
      });
      ranOutOf = ranOutOf ?? plan.ranOutOf;
      ranOut = ranOut || plan.ranOut;
      noCrossing = noCrossing || plan.noCrossing;
    });
    if (error) {
      req.flash('danger', error);
      return res.redirect('/admin/levels');
    }

    const made = repo.transaction(() => planned.map(({ words, difficulty: grade }) => {
      const result = repo.newLevelFromQuestions(words.map((w) => w.id));
      if (result.error) return null;
      repo.setLevelDetails(result.level.id, { difficulty: grade });
      if (publish) repo.setPublished(result.level.id, true);
      return repo.getLevel(result.level.id);
    }).filter(Boolean));

    // Why fewer levels than asked for, in the words the panel uses elsewhere.
    const short = made.length < count
      ? ranOutOf ? ` No free questions left in ${ranOutOf}.`
        : ranOut ? ' No free questions left for another level.'
          : noCrossing ? ' The questions left do not cross, so no more levels could be built.' : ''
      : '';
    if (!made.length) {
      req.flash('warning', `No level could be built.${short}`);
      return res.redirect('/admin/levels');
    }
    const names = made.length === 1 ? made[0].name : `${made[0].name} – ${made[made.length - 1].name}`;
    req.flash('success', `Generated ${made.length} level(s) of ${size}: ${names}${publish ? ', published' : ' as drafts'}.${short}`);
    res.redirect('/admin/levels');
  });

  router.post('/levels/order-by-difficulty', (req, res) => {
    const moved = repo.orderByDifficulty();
    req.flash('success', moved
      ? `Reordered: ${moved} level(s) moved. Easy levels come first, then medium, then hard; fewer words first within each.`
      : 'Already in order — nothing moved.');
    res.redirect('/admin/levels');
  });

  router.post('/levels', (req, res) => {
    const level = repo.createLevel();
    req.flash('success', `Added ${level.name}. Pick its questions below.`);
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
      title: level.name,
      level,
      cells: [...cells.values()],
      // A question belongs to one level: others' questions are not offered here.
      questions: repo.questionsForLevel(level.id),
      difficulties: DIFFICULTIES,
      chosen,
    });
  });

  /** Bulk actions on the levels list: publish, unpublish, re-grade, delete. */
  router.post('/levels/bulk', (req, res) => {
    const ids = req.body.ids ?? [];
    if (!(Array.isArray(ids) ? ids.length : ids)) {
      req.flash('warning', 'Select at least one level first.');
      return res.redirect('/admin/levels');
    }
    switch (req.body.action) {
      case 'publish':
      case 'unpublish': {
        const on = req.body.action === 'publish';
        const { changed, problems, error } = repo.setLevelsPublished(ids, on);
        if (error) { req.flash('danger', error); break; }
        const done = `${on ? 'Published' : 'Unpublished'} ${changed.length} level(s).`;
        req.flash(problems.length ? 'warning' : 'success',
          problems.length ? `${done} ${problems.join(' ')}` : done);
        break;
      }
      case 'difficulty': {
        const { changed, error } = repo.setLevelsDifficulty(ids, req.body.difficulty);
        req.flash(error ? 'danger' : 'success', error ?? `Difficulty set on ${changed} level(s).`);
        break;
      }
      case 'delete': {
        const { deleted, error } = repo.deleteLevels(ids);
        req.flash(error ? 'danger' : 'success',
          error ?? `Deleted ${deleted} level(s). Their questions are back in the bank.`);
        break;
      }
      default:
        req.flash('warning', 'Choose what to do with the selected levels.');
    }
    res.redirect('/admin/levels');
  });

  // The level as the app draws it, in a phone-sized frame. Drafts too.
  router.get('/levels/:id/preview', (req, res, next) => {
    const level = repo.getLevel(Number(req.params.id));
    if (!level) return next();
    res.render('level-preview', {
      title: `Preview · ${level.name}`, level, preview: previewLevel(level, { pictureSize }), coins: STARTING_COINS,
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

  levelAction('details', (id, req) => {
    const result = repo.setLevelDetails(id, { difficulty: req.body.difficulty });
    req.flash(result.error ? 'danger' : 'success', result.error ?? 'Difficulty saved.');
  });

  levelAction('words', (id, req) => {
    const raw = req.body.questions;
    const ids = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const { layout, unpublished, skipped } = repo.setLevelQuestions(id, ids);
    if (skipped.length) {
      req.flash('warning', `${skipped.length} question(s) were left out because they are already in another level.`);
    } else if (unpublished) req.flash('warning', 'Saved, and unpublished: the grid can no longer be published as it is.');
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

  registerStats(router, { events });
  registerImport(router, { repo, images, audio, pendingImports, titleNames });
  if (titles) registerTitles(router, { titles });
  registerSettings(router, { appConfig, siteSettings });
  registerPlayers(router, { players });
  if (profiles) registerProfiles(router, { profiles });
  if (wordSearch && wordSearchDays) {
    registerDaily(router, { wordSearch, wordSearchDays });
    registerWordSearch(router, { wordSearch });
  }
  if (dailyGames) registerDailyGames(router, { dailyGames });
  if (dailyGames && wordSearch && wordSearchDays) registerDays(router, { dailyGames, wordSearch, wordSearchDays });
  registerNotifications(router, { repo, devices, notifications, apnsCredentials });

  return router;
}
