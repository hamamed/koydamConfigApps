import express from 'express';
import rateLimit from 'express-rate-limit';

import { parseDay, todayUtc } from '../daily.js';
import { readEventBatch } from '../events.js';

/**
 * What the iOS app reads, plus the one thing it writes: anonymous gameplay
 * events. Levels are game content, not anything to protect.
 *
 * Every error is `{ error: message }` with a 4xx or 5xx status.
 */
export function apiRouter({ repo, publicUrl, daily, appConfig, events }) {
  const router = express.Router();

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
    clue: w.clue,
    row: w.row,
    col: w.col,
    direction: w.direction,
    type: w.type,
    // Sent whenever there is a picture, whatever the type: an app from before
    // types existed shows it, and an audio question may use one as its cover.
    image: imageOf(w),
    emoji: w.type === 'emoji' ? w.emoji : null,
    audio: w.type === 'audio' && w.audioFile ? { url: `${publicUrl}/media/audio/${w.audioFile}` } : null,
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

  router.get('/config', cacheable, (_req, res) => {
    res.json(appConfig.get());
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

  router.get('/daily', cacheable, (req, res) => {
    const raw = req.query.date;
    const parsed = raw === undefined ? parseDay(todayUtc()) : parseDay(raw);
    if (!parsed) return res.status(400).json({ error: 'The date must be a calendar date written YYYY-MM-DD.' });

    const pick = daily.forDate(parsed.date);
    const level = pick && repo.publishedLevelById(pick.levelId);
    if (!level) return res.status(404).json({ error: 'There is no daily puzzle yet.' });

    res.json({ ...levelBody(level), number: 0, date: parsed.date, coins: appConfig.get().dailyPuzzleCoins });
  });

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

  // Body-parser errors (too large, not JSON) arrive here, and must still be JSON.
  // eslint-disable-next-line no-unused-vars
  router.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    const message = status === 413 ? 'The body is larger than 64 kB.'
      : err.type === 'entity.parse.failed' ? 'The body is not valid JSON.'
        : status >= 500 ? 'Something went wrong.' : err.message;
    res.status(status).json({ error: message });
  });

  return router;
}
