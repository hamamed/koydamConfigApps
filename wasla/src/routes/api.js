import express from 'express';
import rateLimit from 'express-rate-limit';

import { configForApp } from '../app-config.js';
import { parseDay, todayUtc } from '../daily.js';
import { readDeviceRegistration } from '../devices.js';
import { readEventBatch } from '../events.js';
import { readReport, REASONS } from '../reports.js';
import { DAILY_TITLE } from '../level-label.js';
import { registerAudioIngest } from './api-audio.js';
import { registerProfileApi } from './api-profiles.js';

/**
 * What the iOS app reads, plus the one thing it writes: anonymous gameplay
 * events. Levels are game content, not anything to protect.
 *
 * Every error is `{ error: message }` with a 4xx or 5xx status.
 */
export function apiRouter({ repo, publicUrl, daily, appConfig, events, devices, wordSearch, wordSearchDays, dailyGames, lab, profiles, notifications, audioClips = null, reports = null }) {
  const router = express.Router();

  // The one machine-to-machine door (api-audio.js); absent without SERVICE_TOKEN.
  registerAudioIngest(router, { audioClips });

  /** Older uploads belong to no clip and are sent as they always were. */
  const publishableAudio = (file) => (audioClips ? audioClips.isPublishable(file) : true);

  const imageOf = (word) => (word.imageFile ? {
    url: `${publicUrl}/media/questions/${word.imageFile}`,
    zoom: word.zoom,
    focusX: word.focusX,
    focusY: word.focusY,
    blurred: word.blurred,
  } : null);

  /** A word as the app receives it: played letters in `answer`, the spelling in `answerDisplay`. */
  const wordOf = (w) => ({
    id: w.id,
    answer: w.playAnswer,
    answerDisplay: w.answer,
    // Shown above the question. Empty for an older question saved without one.
    title: w.title ?? '',
    clue: w.clue,
    row: w.row,
    col: w.col,
    direction: w.direction,
    type: w.type,
    // Sent whenever there is a picture, whatever the type: an app from before
    // types existed shows it, and an audio question may use one as its cover.
    image: imageOf(w),
    emoji: w.type === 'emoji' ? w.emoji : null,
    // A sound the library is still holding back is not sent at all: a clip kept
    // to listen to reaches no player until its permission is recorded.
    audio: w.type === 'audio' && w.audioFile && publishableAudio(w.audioFile)
      ? { url: `${publicUrl}/media/audio/${w.audioFile}` } : null,
  });

  const levelBody = (level) => ({ ...level, words: level.words.map(wordOf) });

  // ── Reads ─────────────────────────────────────────────────────────────────

  // A minute is enough: an edit in the panel reaches players quickly, and a
  // player opening the levels list twice does not ask twice.
  const cacheable = (_req, res, next) => {
    res.set('Cache-Control', 'public, max-age=60');
    next();
  };

  router.get('/health', cacheable, (_req, res) => res.json({ ok: true }));

  // Picture credits (contract §8): what the app shows under "مصادر الصور".
  /**
   * Who took each picture, and under which licence (contract §8).
   *
   * The answer is deliberately not here. Attribution needs the author, the
   * licence and a link to the picture — naming the word it hides adds nothing
   * to that and turns a public endpoint into an answer key for every picture
   * question in the game. The category is context enough.
   */
  router.get('/credits', cacheable, (_req, res) => {
    res.json({
      credits: repo.credited().map((q) => ({
        title: q.title, author: q.imageAuthor, licence: q.imageLicence, source: q.imageSource,
      })),
    });
  });

  router.get('/config', cacheable, (_req, res) => {
    res.json(configForApp(appConfig.get()));
  });

  router.get('/levels', cacheable, (_req, res) => {
    res.json({ levels: repo.publishedLevels() });
  });

  router.get('/levels/:number', cacheable, (req, res) => {
    const number = Number(req.params.number);
    const level = Number.isInteger(number) && number > 0 ? repo.publishedLevel(number) : null;
    if (!level) return res.status(404).json({ error: 'No such level.' });
    res.json(levelBody(level));
  });

  // Legacy: the crossword daily puzzle, for app builds from before the word
  // search. The panel no longer plans it; dates already in daily_levels still apply.
  router.get('/daily', cacheable, (req, res) => {
    const raw = req.query.date;
    const parsed = raw === undefined ? parseDay(todayUtc()) : parseDay(raw);
    if (!parsed) return res.status(400).json({ error: 'التاريخ يُكتب هكذا YYYY-MM-DD ويجب أن يكون تاريخاً صحيحاً.' });

    const pick = daily.forDate(parsed.date);
    const level = pick && repo.publishedLevelById(pick.levelId);
    if (!level) return res.status(404).json({ error: 'There is no daily puzzle yet.' });

    res.json({ ...levelBody(level), number: 0, title: DAILY_TITLE, date: parsed.date, coins: appConfig.get().dailyPuzzleCoins });
  });

  // The daily word search (contract §5): a board of letters built from one theme.
  // A board planned in the panel wins; any other date gets the automatic one.
  router.get('/wordsearch', cacheable, (req, res) => {
    const raw = req.query.date;
    const parsed = raw === undefined ? parseDay(todayUtc()) : parseDay(raw);
    if (!parsed) return res.status(400).json({ error: 'التاريخ يُكتب هكذا YYYY-MM-DD ويجب أن يكون تاريخاً صحيحاً.' });
    if (!wordSearch) return res.status(503).json({ error: 'The word search is not available.' });

    const board = wordSearchDays ? wordSearchDays.boardFor(parsed.date) : wordSearch.forDate(parsed.date);
    if (!board) return res.status(404).json({ error: 'There is no word search yet: no theme has enough words.' });
    res.json(board);
  });

  // The five daily games beside the word search (contract §6).
  router.get('/daily-games', cacheable, (req, res) => {
    const raw = req.query.date;
    const parsed = raw === undefined ? parseDay(todayUtc()) : parseDay(raw);
    if (!parsed) return res.status(400).json({ error: 'التاريخ يُكتب هكذا YYYY-MM-DD ويجب أن يكون تاريخاً صحيحاً.' });
    if (!dailyGames) return res.status(503).json({ error: 'The daily games are not available.' });

    const set = dailyGames.forDate(parsed.date);
    if (!set) return res.status(404).json({ error: 'There are no daily games yet.' });
    res.json(set);
  });

  // The lab games' content (جِذر and قوافي). The app ships with the same lists
  // and falls back to them, so this answering late — or not at all — only means
  // the phone plays the built-in ones.
  router.get('/lab', cacheable, (_req, res) => {
    if (!lab) return res.status(503).json({ error: 'محتوى المختبر غير متاح.' });
    res.json(lab.content());
  });

  if (profiles) registerProfileApi(router, { profiles, notifications });

  // ── Events ────────────────────────────────────────────────────────────────

  // Generous for one player — the app sends a batch every so often, not per
  // tap — and tight enough that one address cannot fill the table.
  const eventsLimiter = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: 'Too many event batches. Try again in a minute.' }),
  });

  router.post('/events', eventsLimiter, express.json({ limit: '64kb' }), (req, res) => {
    res.set('Cache-Control', 'no-store');
    const batch = readEventBatch(req.body);
    if (batch.error) return res.status(400).json({ error: batch.error });
    res.status(202).json({ accepted: events.record(batch) });
  });

  // ── Reporting a question ──────────────────────────────────────────────────

  // The reasons the app draws its list from, so the two never drift apart.
  router.get('/report-reasons', cacheable, (_req, res) => {
    res.json({ reasons: Object.entries(REASONS).map(([key, label]) => ({ key, label })) });
  });

  // A player reports a handful of questions in a session at most; the module
  // holds a per-device ceiling of its own on top of this per-address one.
  const reportLimiter = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: 'Too many reports. Try again in a minute.' }),
  });

  router.post('/questions/:id/report', reportLimiter, express.json({ limit: '4kb' }), (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!reports) return res.status(503).json({ error: 'Reporting is not available.' });
    const read = readReport(req.body);
    if (read.error) return res.status(400).json({ error: read.error });
    const filed = reports.add(Number(req.params.id), read.report);
    if (filed.error) {
      // A gone question is the app's mistake to know about; a ceiling is not.
      return res.status(filed.error.startsWith('No such') ? 404 : 429).json({ error: filed.error });
    }
    res.status(201).json({ reported: true });
  });

  // ── Push registration ─────────────────────────────────────────────────────

  // The app posts when its token or permission changes, which is rare; the
  // same allowance as events is plenty.
  const devicesLimiter = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: 'Too many registrations. Try again in a minute.' }),
  });

  router.post('/devices', devicesLimiter, express.json({ limit: '4kb' }), (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!devices) return res.status(503).json({ error: 'Push registration is not available.' });
    const { registration, error } = readDeviceRegistration(req.body);
    if (error) return res.status(400).json({ error });
    devices.register(registration);
    res.status(204).end();
  });

  // Body-parser errors (too large, not JSON) arrive here, and must still be JSON.
  // eslint-disable-next-line no-unused-vars
  router.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    const message = status === 413 ? `The body is larger than ${Math.round((err.limit || 64 * 1024) / 1024)} kB.`
      : err.type === 'entity.parse.failed' ? 'The body is not valid JSON.'
        : status >= 500 ? 'Something went wrong.' : err.message;
    res.status(status).json({ error: message });
  });

  return router;
}
