import crypto from 'node:crypto';

import multer from 'multer';
import rateLimit from 'express-rate-limit';

import { config } from '../config.js';

/**
 * One machine-to-machine door: a finished clip, posted into the sound library.
 *
 * It exists because YouTube refuses the VPS — it blocks datacentre addresses —
 * so a video has to be fetched from an ordinary machine. `scripts/youtube-clip.js`
 * does that and posts the result here, which then goes through exactly the same
 * `audioClips.save` an upload in the panel goes through: same cut, same checks,
 * same credit.
 *
 * It is guarded by SERVICE_TOKEN, and when that is unset the route does not
 * exist at all — an install that never set a token has nothing to find.
 */

/** Constant-time, and never true for a token of the wrong length. */
function tokenMatches(given, expected) {
  if (!given || !expected || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

const bearer = (req) => {
  const header = String(req.get('authorization') ?? '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
};

export function registerAudioIngest(router, { audioClips }) {
  // Nothing to guard the door with means no door.
  if (!audioClips || !config.serviceToken) return;

  const limiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxAudioBytes } })
    .single('sound');

  router.post('/audio-clips', limiter, (req, res, next) => {
    if (!tokenMatches(bearer(req), config.serviceToken)) {
      return res.status(401).json({ error: 'Bad or missing service token.' });
    }
    upload(req, res, async (err) => {
      if (err) return res.status(413).json({ error: 'The sound is too large.' });
      try {
        if (!req.file?.buffer?.length) return res.status(400).json({ error: 'Send the sound as `sound`.' });
        const saved = await audioClips.save(req.file.buffer, {
          title: req.body.title,
          category: req.body.category,
          start: req.body.start ?? 0,
          seconds: req.body.seconds,
          source: req.body.source,
          licence: req.body.licence,
          author: req.body.author,
        });
        if (saved.error) return res.status(400).json({ error: saved.error });
        res.status(201).json({
          clip: {
            id: saved.clip.id,
            title: saved.clip.title,
            category: saved.clip.category,
            seconds: saved.clip.seconds,
            licence: saved.clip.licence,
            author: saved.clip.author,
          },
        });
      } catch (error) {
        next(error);
      }
    });
  });
}
