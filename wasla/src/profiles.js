/**
 * Player profiles and the leaderboards built on them (contract §7).
 *
 * A profile is a public username and an avatar icon — no email, no password.
 * Creating one returns a random token that the app keeps in the keychain and
 * sends as `Authorization: Bearer …`; only its SHA-256 is stored, so the
 * database alone cannot act as a player.
 *
 * Scores are sent by the app and checked for shape and plausibility, not
 * proven: a daily time is taken once per date and only for dates around
 * today, and totals are whole numbers in range.
 */

import crypto from 'node:crypto';

import { foldForPlay } from './arabic.js';
import { addDays } from './players.js';

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 16;
export const LEADERBOARD_SIZE = 50;
export const BOARDS = Object.freeze(['today-ladder', 'today-allgames', 'today-wordsearch', 'stars', 'points', 'streak']);
export const DAILY_KINDS = Object.freeze({ wordsearch: 'wordsearch', allgames: 'allgames', ladder: 'ladder' });
/** Faster than this is not a real solve. */
export const MIN_SECONDS = Object.freeze({ wordsearch: 10, allgames: 30, ladder: 30 });
/** A ladder is five rungs of three stars. */
export const MAX_LADDER_STARS = 15;
const MAX_SECONDS = 86_400;
const MAX_TOTAL = 1_000_000_000;
const MAX_BADGES = 100;
const BADGE_ID = /^[a-z0-9][a-z0-9._-]{1,48}$/;

/** The avatars a player can pick from: icon ids the app draws (asset `avatar-<id>`). */
export const AVATARS = Object.freeze([
  'paw', 'pet', 'fish', 'clownfish', 'blue-tang', 'rubber-duck', 'teddy-bear', 'cactus',
  'palm-tree', 'flower', 'mushroom', 'tree', 'moon', 'planet', 'rainbow', 'volcano',
  'star-gem', 'crystal-ball', 'dice', 'brain', 'anchor', 'balloon', 'paper-plane', 'seashell',
  'crown', 'gem', 'crystal', 'sun', 'sprout', 'snowflake', 'tornado', 'firework',
  'piggy-bank', 'wizard-hat', 'chef-hat', 'feather', 'globe', 'origami', 'snowman', 'leaf',
  'face', 'smiley', 'puppy', 'ghost', 'gingerbread', 'ufo', 'rocket', 'magic-carpet',
  'controller', 'headset', 'guitar', 'microphone', 'soccer-ball', 'basketball', 'burger', 'candy',
  'apple', 'atom', 'heart', 'party-popper', 'lightning', 'compass', 'palette', 'glasses',
  'cap', 'hot-chocolate', 'book', 'key', 'lantern', 'maple-leaf',
  // Seasonal (locked in the app until their event; the server does not check).
  'fanous', 'eidiya', 'friday-star',
]);

/** The frames a player can put round their avatar (the app draws them); null is none. */
export const FRAMES = Object.freeze(['ramadan', 'eid']);

// Arabic letters, Arabic-Indic digits, Latin letters, digits and underscore.
const USERNAME = /^[ء-غف-ي٠-٩A-Za-z0-9_]+$/u;
const HAS_LETTER = /[ء-غف-يA-Za-z]/u;

/** Names nobody may take, compared by key. */
const RESERVED = ['admin', 'administrator', 'moderator', 'support', 'wasla', 'wassla', 'shabbik', 'shabik', 'koydam',
  'وصلة', 'وصله', 'شبك', 'شبّك', 'الادارة', 'الدعم', 'مشرف'];
/** Parts that make a name unacceptable anywhere in it (kept short; the panel can rename or ban). */
const BLOCKED_PARTS = ['fuck', 'shit', 'bitch', 'porn', 'sex', 'nazi', 'زب', 'كس', 'شرموط', 'قحب', 'منيك', 'نيك', 'خرا'];

/** Names that differ only by case, hamza forms, ة/ه or digit script are the same name. */
export function usernameKey(raw) {
  return foldForPlay(String(raw ?? '').normalize('NFC').trim().toLowerCase())
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/ة/g, 'ه');
}

/** `{ username }` cleaned, or `{ error }` in Arabic for the app to show. */
export function readUsername(raw) {
  const username = String(raw ?? '').normalize('NFC').trim();
  const length = [...username].length;
  if (length < USERNAME_MIN || length > USERNAME_MAX) {
    return { error: `اسم المستخدم من ${USERNAME_MIN} إلى ${USERNAME_MAX} حرفاً` };
  }
  if (!USERNAME.test(username)) return { error: 'استعمل الحروف والأرقام و _ فقط، بلا مسافات' };
  if (!HAS_LETTER.test(username)) return { error: 'يجب أن يحتوي الاسم على حرف واحد على الأقل' };
  const key = usernameKey(username);
  if (RESERVED.some((r) => usernameKey(r) === key)) return { error: 'هذا الاسم محجوز' };
  if (BLOCKED_PARTS.some((part) => key.includes(usernameKey(part)))) return { error: 'اختر اسماً آخر' };
  return { username, key };
}

export const readAvatar = (raw) => (AVATARS.includes(raw) ? raw : null);

/** `{ frame }` — an id from FRAMES, or null for null/'' (no frame) — or `{ error }`. */
export function readFrame(raw) {
  if (raw === null || raw === '') return { frame: null };
  return FRAMES.includes(raw) ? { frame: raw } : { error: 'اختر إطاراً من القائمة' };
}

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** Letters and digits nobody misreads: no O/0, I/1, S/5. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';
export const RECOVERY_CODE = /^WSL-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

/** A fresh recovery code, "WSL-3K7Q-9F2M". Shown once in the app; only its hash is stored. */
export function newRecoveryCode() {
  const pick = () => Array.from(crypto.randomBytes(4), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `WSL-${pick()}-${pick()}`;
}

/** The code as it is compared: upper case, hyphens where they belong. */
export function readRecoveryCode(raw) {
  const clean = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = clean.startsWith('WSL') ? clean.slice(3) : clean;
  if (body.length !== 8) return null;
  const code = `WSL-${body.slice(0, 4)}-${body.slice(4)}`;
  return RECOVERY_CODE.test(code) ? code : null;
}
const whole = (v, max = MAX_TOTAL) => (Number.isInteger(v) && v >= 0 && v <= max ? v : null);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isRealDate = (date) => DATE.test(date) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;

/** The totals the app syncs, checked; `{ error }` for a bad body. */
export function readStats(body) {
  const stats = {
    points: whole(body?.points),
    levelsCompleted: whole(body?.levelsCompleted),
    wordsSolved: whole(body?.wordsSolved),
    streak: whole(body?.streak, 100_000),
    bestStreak: whole(body?.bestStreak, 100_000),
    // Sent by apps from the stars board on; older ones leave it out.
    stars: body?.stars === undefined ? 0 : whole(body.stars, 1_000_000),
  };
  const best = body?.bestAllGamesSeconds ?? null;
  if (best !== null && !(Number.isInteger(best) && best >= MIN_SECONDS.allgames && best <= MAX_SECONDS)) {
    return { error: `"bestAllGamesSeconds" must be null or a whole number from ${MIN_SECONDS.allgames} to ${MAX_SECONDS}.` };
  }
  const missing = Object.entries(stats).find(([, v]) => v === null);
  if (missing) return { error: `"${missing[0]}" must be a whole number, 0 or more.` };
  const streakDate = body?.streakDate ?? null;
  if (streakDate !== null && !isRealDate(streakDate)) return { error: '"streakDate" must be YYYY-MM-DD or null.' };
  const badges = body?.badges ?? [];
  if (!Array.isArray(badges) || badges.length > MAX_BADGES || !badges.every((b) => typeof b === 'string' && BADGE_ID.test(b))) {
    return { error: `"badges" must be a list of at most ${MAX_BADGES} badge ids.` };
  }
  return { stats: { ...stats, bestStreak: Math.max(stats.bestStreak, stats.streak), streakDate, badges: [...new Set(badges)], bestAllGamesSeconds: best } };
}

/** A daily time, checked against today on the server (a day either side, for time zones). */
export function readDailyTime(body, today) {
  const kind = DAILY_KINDS[body?.kind];
  if (!kind) return { error: `"kind" must be one of: ${Object.keys(DAILY_KINDS).join(', ')}.` };
  const date = body?.date;
  if (typeof date !== 'string' || !isRealDate(date)) return { error: '"date" must be YYYY-MM-DD.' };
  if (date < addDays(today, -1) || date > addDays(today, 1)) return { error: 'That date is not today.' };
  const seconds = body?.seconds;
  if (!Number.isInteger(seconds) || seconds < MIN_SECONDS[kind] || seconds > MAX_SECONDS) {
    return { error: `"seconds" must be a whole number from ${MIN_SECONDS[kind]} to ${MAX_SECONDS}.` };
  }
  // A climb is ranked by its stars first, so it sends them with its time.
  const stars = body?.stars ?? null;
  if (kind === 'ladder' && !(Number.isInteger(stars) && stars >= 0 && stars <= MAX_LADDER_STARS)) {
    return { error: `"stars" must be a whole number from 0 to ${MAX_LADDER_STARS}.` };
  }
  return { kind, date, seconds, stars: kind === 'ladder' ? stars : null };
}

export function createProfiles(db, { now = () => new Date() } = {}) {
  const today = () => now().toISOString().slice(0, 10);

  const byToken = db.prepare('SELECT * FROM profiles WHERE token_hash = ?');
  const byKey = db.prepare('SELECT * FROM profiles WHERE username_key = ?');
  const byId = db.prepare('SELECT * FROM profiles WHERE id = ?');
  const badgesOf = db.prepare('SELECT badge FROM profile_badges WHERE profile_id = ? ORDER BY earned_at, badge');

  /** The profile a bearer token belongs to (banned ones included; the caller decides), or null. */
  const authenticate = (token) => (typeof token === 'string' && token.length >= 20 ? byToken.get(hashToken(token)) ?? null : null);

  const isTaken = (key, exceptId = null) => {
    const row = byKey.get(key);
    return Boolean(row && row.id !== exceptId);
  };

  /** `{ available }` or `{ error }` for a name typed in the app. */
  function checkUsername(raw, exceptId = null) {
    const read = readUsername(raw);
    if (read.error) return { available: false, error: read.error };
    return isTaken(read.key, exceptId) ? { available: false, error: 'هذا الاسم مأخوذ' } : { available: true };
  }

  /** `{ profile, token }`, or `{ error, status }`. */
  function create({ username, avatar }) {
    const read = readUsername(username);
    if (read.error) return { error: read.error, status: 400 };
    const face = readAvatar(avatar);
    if (!face) return { error: 'اختر صورة من القائمة', status: 400 };
    if (isTaken(read.key)) return { error: 'هذا الاسم مأخوذ', status: 409 };
    const token = crypto.randomBytes(32).toString('base64url');
    const recoveryCode = newRecoveryCode();
    try {
      const info = db.prepare('INSERT INTO profiles (username, username_key, avatar, token_hash, recovery_hash) VALUES (?, ?, ?, ?, ?)')
        .run(read.username, read.key, face, hashToken(token), hashToken(recoveryCode));
      return { profile: byId.get(info.lastInsertRowid), token, recoveryCode };
    } catch (err) {
      if (String(err.code).startsWith('SQLITE_CONSTRAINT')) return { error: 'هذا الاسم مأخوذ', status: 409 };
      throw err;
    }
  }

  /** Changes the username, avatar and/or frame. `{ profile }` or `{ error, status }`. */
  function update(profile, { username, avatar, frame }, { force = false } = {}) {
    const changes = {};
    if (username !== undefined) {
      const read = force ? forcedUsername(username) : readUsername(username);
      if (read.error) return { error: read.error, status: 400 };
      if (isTaken(read.key, profile.id)) return { error: 'هذا الاسم مأخوذ', status: 409 };
      changes.username = read.username;
      changes.username_key = read.key;
    }
    if (avatar !== undefined) {
      const face = readAvatar(avatar);
      if (!face) return { error: 'اختر صورة من القائمة', status: 400 };
      changes.avatar = face;
    }
    if (frame !== undefined) {
      const read = readFrame(frame);
      if (read.error) return { error: read.error, status: 400 };
      changes.frame = read.frame;
    }
    if (!Object.keys(changes).length) return { profile };
    const sets = Object.keys(changes).map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE profiles SET ${sets}, updated_at = datetime('now') WHERE id = @id`).run({ ...changes, id: profile.id });
    return { profile: byId.get(profile.id) };
  }

  /** The panel may rename past the reserved list, but not to an invalid or taken name. */
  function forcedUsername(raw) {
    const username = String(raw ?? '').normalize('NFC').trim();
    const length = [...username].length;
    if (length < USERNAME_MIN || length > USERNAME_MAX || !USERNAME.test(username)) return { error: 'Not a valid username.' };
    return { username, key: usernameKey(username) };
  }

  function saveStats(profile, stats) {
    db.transaction(() => {
      db.prepare(`UPDATE profiles SET points = @points, stars = MAX(stars, @stars), levels_completed = @levelsCompleted, words_solved = @wordsSolved,
          best_allgames_seconds = CASE WHEN @bestAllGamesSeconds IS NULL THEN best_allgames_seconds
            WHEN best_allgames_seconds IS NULL THEN @bestAllGamesSeconds ELSE MIN(best_allgames_seconds, @bestAllGamesSeconds) END,
          streak = @streak, best_streak = MAX(best_streak, @bestStreak), streak_date = @streakDate,
          stats_updated_at = datetime('now') WHERE id = @id`).run({ ...stats, id: profile.id });
      const insert = db.prepare('INSERT INTO profile_badges (profile_id, badge) VALUES (?, ?) ON CONFLICT DO NOTHING');
      for (const badge of stats.badges) insert.run(profile.id, badge);
    })();
    return byId.get(profile.id);
  }

  /** Keeps the first time sent for that date and kind. `{ seconds, isNew }`. */
  function saveDailyTime(profile, { kind, date, seconds, stars = null }) {
    const column = `${kind}_seconds`;
    const stamp = `${kind}_at`;
    db.prepare(`INSERT INTO profile_daily (profile_id, date, ${column}, ${stamp}) VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(profile_id, date) DO UPDATE SET ${column} = excluded.${column}, ${stamp} = excluded.${stamp}
      WHERE profile_daily.${column} IS NULL`).run(profile.id, date, seconds);
    // The stars belong to the climb that was kept, not to a later one.
    if (kind === 'ladder') {
      db.prepare(`UPDATE profile_daily SET ladder_stars = ?
        WHERE profile_id = ? AND date = ? AND ladder_seconds = ? AND ladder_stars IS NULL`)
        .run(stars ?? 0, profile.id, date, seconds);
    }
    const kept = db.prepare(`SELECT ${column} AS seconds FROM profile_daily WHERE profile_id = ? AND date = ?`).get(profile.id, date);
    if (kind === 'allgames') {
      db.prepare('UPDATE profiles SET best_allgames_seconds = MIN(IFNULL(best_allgames_seconds, ?), ?) WHERE id = ?').run(kept.seconds, kept.seconds, profile.id);
    }
    return { seconds: kept.seconds, isNew: kept.seconds === seconds };
  }

  const remove = (profile) => db.prepare('DELETE FROM profiles WHERE id = ?').run(profile.id).changes > 0;

  /** Links a phone (its anonymous install id) to the profile, so rank pushes can reach it. */
  function linkDevice(profile, device) {
    db.prepare(`INSERT INTO profile_devices (profile_id, device) VALUES (?, ?)
      ON CONFLICT(profile_id, device) DO UPDATE SET updated_at = datetime('now')`).run(profile.id, device);
  }

  const devicesOf = (profileId) => db.prepare('SELECT device FROM profile_devices WHERE profile_id = ?').pluck().all(profileId);

  /**
   * After `profile` posted an all-games time: the player just behind it (the one it
   * passed), if they were not told yet that day — marked told. `{ profile, rank }` or null.
   */
  function claimPassedPlayer(profile, date) {
    return db.transaction(() => {
      const mine = db.prepare('SELECT allgames_seconds AS s FROM profile_daily WHERE profile_id = ? AND date = ?').get(profile.id, date)?.s;
      if (mine == null) return null;
      const passed = db.prepare(`SELECT p.* FROM profile_daily d JOIN profiles p ON p.id = d.profile_id
        WHERE d.date = ? AND d.allgames_seconds > ? AND p.banned = 0 AND p.id <> ? AND d.passed_notified_at IS NULL
        ORDER BY d.allgames_seconds ASC, d.allgames_at ASC LIMIT 1`).get(date, mine, profile.id);
      if (!passed) return null;
      db.prepare("UPDATE profile_daily SET passed_notified_at = datetime('now') WHERE profile_id = ? AND date = ?").run(passed.id, date);
      return { profile: passed, rank: leaderboard('today-allgames', { date, viewer: passed, limit: 0 }).me?.rank ?? null };
    })();
  }

  // ── Recovery ─────────────────────────────────────────────────────────────

  /**
   * The profile a recovery code belongs to, with a **new** token: the phone that
   * recovers becomes the one that holds the profile, and the old one signs out.
   * `{ token, profile }`, or `{ error, status }` for an unknown code or a banned profile.
   */
  function recover(rawCode) {
    const code = readRecoveryCode(rawCode);
    if (!code) return { error: 'رمز الاسترجاع غير صحيح', status: 400 };
    const profile = db.prepare('SELECT * FROM profiles WHERE recovery_hash = ?').get(hashToken(code));
    if (!profile) return { error: 'لا يوجد ملف بهذا الرمز', status: 404 };
    if (profile.banned) return { error: 'هذا الحساب موقوف', status: 403 };
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare("UPDATE profiles SET token_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hashToken(token), profile.id);
    return { token, profile: byId.get(profile.id) };
  }

  /** A new code for a profile; the old one stops working. The caller shows it once. */
  function resetRecoveryCode(profile) {
    const code = newRecoveryCode();
    db.prepare("UPDATE profiles SET recovery_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hashToken(code), profile.id);
    return code;
  }

  // ── Leaderboards ─────────────────────────────────────────────────────────

  /**
   * For each board: the query for its rows (best first) and for one profile's
   * value. A streak counts only while it is alive: its last daily completion
   * is at most two days before the server's date (time zones plus one day).
   */
  function boardQuery(board, date) {
    const streakAlive = addDays(today(), -2);
    switch (board) {
      case 'today-allgames':
      case 'today-wordsearch': {
        const kind = board === 'today-allgames' ? 'allgames' : 'wordsearch';
        return {
          from: `FROM profile_daily d JOIN profiles p ON p.id = d.profile_id
            WHERE d.date = @date AND d.${kind}_seconds IS NOT NULL AND p.banned = 0`,
          value: `d.${kind}_seconds`,
          order: `d.${kind}_seconds ASC, d.${kind}_at ASC, p.id ASC`,
          better: `(d.${kind}_seconds < @value OR (d.${kind}_seconds = @value AND d.${kind}_at < @at))`,
          at: `d.${kind}_at`,
          params: { date },
        };
      }
      // The day's climb: most stars first, and the fastest of those on top.
      case 'today-ladder':
        return {
          from: `FROM profile_daily d JOIN profiles p ON p.id = d.profile_id
            WHERE d.date = @date AND d.ladder_seconds IS NOT NULL AND p.banned = 0`,
          value: 'd.ladder_stars',
          order: 'd.ladder_stars DESC, d.ladder_seconds ASC, d.ladder_at ASC, p.id ASC',
          better: `(d.ladder_stars > @value
            OR (d.ladder_stars = @value AND (d.ladder_seconds < @seconds
              OR (d.ladder_seconds = @seconds AND d.ladder_at < @at))))`,
          at: 'd.ladder_at',
          seconds: 'd.ladder_seconds',
          params: { date },
        };
      case 'stars':
        return {
          from: 'FROM profiles p WHERE p.banned = 0 AND p.stars > 0',
          value: 'p.stars',
          order: 'p.stars DESC, p.id ASC',
          better: '(p.stars > @value OR (p.stars = @value AND p.id < @id))',
          params: {},
        };
      case 'points':
        return {
          from: 'FROM profiles p WHERE p.banned = 0 AND p.points > 0',
          value: 'p.points',
          order: 'p.points DESC, p.id ASC',
          better: '(p.points > @value OR (p.points = @value AND p.id < @id))',
          params: {},
        };
      case 'streak':
        return {
          from: 'FROM profiles p WHERE p.banned = 0 AND p.streak > 0 AND p.streak_date >= @alive',
          value: 'p.streak',
          order: 'p.streak DESC, p.best_streak DESC, p.id ASC',
          better: '(p.streak > @value OR (p.streak = @value AND p.id < @id))',
          params: { alive: streakAlive },
        };
      default:
        return null;
    }
  }

  /** `{ board, date, entries: [{ rank, username, avatar, frame, stars, value, isMe }], me }` or null for an unknown board. */
  function leaderboard(board, { date = today(), viewer = null, limit = LEADERBOARD_SIZE } = {}) {
    const q = boardQuery(board, date);
    if (!q) return null;
    const rows = db.prepare(`SELECT p.id, p.username, p.avatar, p.frame, p.stars, ${q.value} AS value`
      + `${q.seconds ? `, ${q.seconds} AS seconds` : ''} ${q.from} ORDER BY ${q.order} LIMIT @limit`)
      .all({ ...q.params, limit });
    const entries = rows.map((r, i) => ({
      rank: i + 1, username: r.username, avatar: r.avatar, frame: r.frame ?? null, stars: r.stars, value: r.value,
      ...(r.seconds == null ? {} : { seconds: r.seconds }),
      isMe: r.id === viewer?.id,
    }));
    let me = null;
    if (viewer && !viewer.banned) {
      const mine = db.prepare(`SELECT p.id, ${q.value} AS value${q.at ? `, ${q.at} AS at` : ''}`
        + `${q.seconds ? `, ${q.seconds} AS seconds` : ''} ${q.from} AND p.id = @id`)
        .get({ ...q.params, id: viewer.id });
      if (mine) {
        const ahead = db.prepare(`SELECT COUNT(*) AS n ${q.from} AND ${q.better}`)
          .get({ ...q.params, value: mine.value, at: mine.at ?? '', seconds: mine.seconds ?? 0, id: viewer.id }).n;
        me = { rank: ahead + 1, value: mine.value, ...(mine.seconds == null ? {} : { seconds: mine.seconds }) };
      }
    }
    // How many players the board holds, so a rank can be read as "7th of 213".
    const total = db.prepare(`SELECT COUNT(*) AS n ${q.from}`).get(q.params).n;
    const isDaily = board.startsWith('today-');
    return { board, date: isDaily ? date : null, total, entries: entries.map(({ isMe, ...e }) => ({ ...e, isMe })), me };
  }

  // ── Views ─────────────────────────────────────────────────────────────────

  /** What anyone may see. */
  function publicView(profile) {
    return {
      username: profile.username,
      avatar: profile.avatar,
      frame: profile.frame ?? null,
      joined: profile.created_at.slice(0, 10),
      stats: {
        points: profile.points,
        stars: profile.stars,
        bestAllGamesSeconds: profile.best_allgames_seconds ?? null,
        levelsCompleted: profile.levels_completed,
        wordsSolved: profile.words_solved,
        streak: profile.streak_date && profile.streak_date >= addDays(today(), -2) ? profile.streak : 0,
        bestStreak: profile.best_streak,
      },
      badges: badgesOf.all(profile.id).map((r) => r.badge),
    };
  }

  /** The owner's view: the public one plus today's times and ranks. */
  function ownView(profile, { date = today() } = {}) {
    const day = db.prepare('SELECT wordsearch_seconds, allgames_seconds FROM profile_daily WHERE profile_id = ? AND date = ?').get(profile.id, date);
    const rank = (board) => leaderboard(board, { date, viewer: profile, limit: 0 })?.me?.rank ?? null;
    return {
      id: profile.id,
      ...publicView(profile),
      today: { date, wordsearchSeconds: day?.wordsearch_seconds ?? null, allgamesSeconds: day?.allgames_seconds ?? null },
      ranks: Object.fromEntries(BOARDS.map((b) => [b, rank(b)])),
      banned: Boolean(profile.banned),
    };
  }

  const findByUsername = (raw) => {
    const row = byKey.get(usernameKey(raw));
    return row && !row.banned ? row : null;
  };

  // ── Panel ─────────────────────────────────────────────────────────────────

  function list({ search = '', limit = 200 } = {}) {
    const key = `%${usernameKey(search)}%`;
    return db.prepare(`SELECT id, username, avatar, points, streak, best_streak, levels_completed, banned, created_at, stats_updated_at
      FROM profiles WHERE username_key LIKE ? ORDER BY created_at DESC LIMIT ?`).all(key, limit);
  }

  const count = () => db.prepare('SELECT COUNT(*) AS n, IFNULL(SUM(banned), 0) AS banned FROM profiles').get();
  const setBanned = (id, banned) => db.prepare("UPDATE profiles SET banned = ?, updated_at = datetime('now') WHERE id = ?").run(banned ? 1 : 0, id).changes > 0;
  const get = (id) => byId.get(id) ?? null;

  return {
    authenticate, checkUsername, create, update, saveStats, saveDailyTime, remove, recover, resetRecoveryCode,
    linkDevice, devicesOf, claimPassedPlayer,
    leaderboard, publicView, ownView, findByUsername, list, count, setBanned, get, today,
  };
}
