import express from 'express';
import rateLimit from 'express-rate-limit';

import { isDeviceId } from '../devices.js';
import { AVATARS, BOARDS, FRAMES, readDailyTime, readStats } from '../profiles.js';
import { parseDay } from '../daily.js';

const limiter = (limit, windowMs, message) => rateLimit({
  windowMs,
  limit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: message }),
});

/** The bearer token from `Authorization`, or null. */
const bearer = (req) => /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '')?.[1] ?? null;

/**
 * Profiles and leaderboards (contract §7). Writes need the profile's token;
 * reads of boards and public profiles do not.
 */
/** "06:12" from seconds, as the app shows times. */
const clock = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

/** The push to the player someone just passed on today's board. */
export function passedMessage(passer, seconds, rank) {
  // No verb that says whether the player is a man or a woman: a username does not tell.
  return {
    title: 'وقتك في لغز اليوم تم تجاوزه ⏱️',
    body: `${passer.username}: ${clock(seconds)}${rank ? ` — أنت الآن #${rank}` : ''}`,
  };
}

export function registerProfileApi(router, { profiles, notifications = null }) {
  const json = express.json({ limit: '16kb' });
  const noStore = (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };

  /** Loads the caller's profile; 401 without a valid token, 403 when banned. */
  const requireProfile = (req, res, next) => {
    const profile = profiles.authenticate(bearer(req));
    if (!profile) return res.status(401).json({ error: 'Sign in with a profile token.' });
    if (profile.banned) return res.status(403).json({ error: 'هذا الحساب موقوف' });
    req.profile = profile;
    return next();
  };

  router.get('/profiles/avatars', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ avatars: AVATARS });
  });

  router.get('/profiles/frames', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ frames: FRAMES });
  });

  router.get('/profiles/check', noStore, limiter(60, 60_000, 'Too many checks. Try again in a minute.'), (req, res) => {
    const profile = profiles.authenticate(bearer(req));
    res.json(profiles.checkUsername(req.query.username, profile?.id ?? null));
  });

  router.post('/profiles', noStore, limiter(10, 60 * 60_000, 'Too many new profiles from here. Try again later.'), json, (req, res) => {
    const result = profiles.create(req.body ?? {});
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(201).json({ token: result.token, recoveryCode: result.recoveryCode, profile: profiles.ownView(result.profile) });
  });

  // A code is 8 characters from 30: guessing is hopeless, and this keeps it that way.
  router.post('/profiles/recover', noStore, limiter(10, 60 * 60_000, 'Too many tries. Try again later.'), json, (req, res) => {
    const result = profiles.recover(req.body?.code);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ token: result.token, profile: profiles.ownView(result.profile) });
  });

  const writes = limiter(60, 60_000, 'Too many requests. Try again in a minute.');

  router.get('/profile/me', noStore, writes, requireProfile, (req, res) => {
    const date = parseDay(String(req.query.date ?? ''))?.date;
    res.json({ profile: profiles.ownView(req.profile, date ? { date } : {}) });
  });

  router.patch('/profile/me', noStore, writes, json, requireProfile, (req, res) => {
    const result = profiles.update(req.profile, { username: req.body?.username, avatar: req.body?.avatar, frame: req.body?.frame });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ profile: profiles.ownView(result.profile) });
  });

  router.delete('/profile/me', noStore, writes, (req, res) => {
    // Banned profiles can still be deleted by their owner.
    const profile = profiles.authenticate(bearer(req));
    if (!profile) return res.status(401).json({ error: 'Sign in with a profile token.' });
    profiles.remove(profile);
    res.status(204).end();
  });

  router.put('/profile/me/stats', noStore, writes, json, requireProfile, (req, res) => {
    const { stats, error } = readStats(req.body);
    if (error) return res.status(400).json({ error });
    res.json({ profile: profiles.ownView(profiles.saveStats(req.profile, stats)) });
  });

  router.post('/profile/me/daily', noStore, writes, json, requireProfile, (req, res) => {
    const time = readDailyTime(req.body, profiles.today());
    if (time.error) return res.status(400).json({ error: time.error });
    const saved = profiles.saveDailyTime(req.profile, time);
    const board = { allgames: 'today-allgames', wordsearch: 'today-wordsearch', ladder: 'today-ladder' }[time.kind];
    // Tell the player just passed, once a day; never slows or fails the answer.
    if (time.kind === 'allgames' && saved.isNew && notifications) {
      const passed = profiles.claimPassedPlayer(req.profile, time.date);
      const devices = passed ? profiles.devicesOf(passed.profile.id) : [];
      if (devices.length) {
        notifications.sendToDevices(devices, passedMessage(req.profile, saved.seconds, passed.rank))
          .catch((err) => console.error('Rank push failed:', err));
      }
    }
    const mine = profiles.leaderboard(board, { date: time.date, viewer: req.profile, limit: 0 }).me;
    res.json({ seconds: saved.seconds, rank: mine?.rank ?? null, total: profiles.leaderboard(board, { date: time.date, limit: 0 }).total });
  });

  router.post('/profile/me/device', noStore, writes, json, requireProfile, (req, res) => {
    const device = req.body?.device;
    if (!isDeviceId(device)) return res.status(400).json({ error: '"device" must be the app\'s install id.' });
    profiles.linkDevice(req.profile, device);
    res.status(204).end();
  });

  router.post('/profile/me/recovery-code', noStore, writes, requireProfile, (req, res) => {
    res.json({ recoveryCode: profiles.resetRecoveryCode(req.profile) });
  });

  router.get('/leaderboards/:board', noStore, writes, (req, res) => {
    if (!BOARDS.includes(req.params.board)) return res.status(404).json({ error: 'No such leaderboard.' });
    const raw = req.query.date;
    const parsed = raw === undefined ? null : parseDay(String(raw));
    if (raw !== undefined && !parsed) return res.status(400).json({ error: 'The date must be a calendar date written YYYY-MM-DD.' });
    const viewer = profiles.authenticate(bearer(req));
    res.json(profiles.leaderboard(req.params.board, { date: parsed?.date ?? profiles.today(), viewer }));
  });

  router.get('/profiles/:username', noStore, writes, (req, res) => {
    const profile = profiles.findByUsername(req.params.username);
    if (!profile) return res.status(404).json({ error: 'No such player.' });
    res.json({ profile: profiles.publicView(profile) });
  });
}
