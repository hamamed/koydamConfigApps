import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import express from 'express';

import { openDatabase } from '../src/db/index.js';
import {
  AVATARS, BOARDS, createProfiles, FRAMES, readDailyTime, readFrame, readStats, readUsername, usernameKey,
} from '../src/profiles.js';
import { apiRouter } from '../src/routes/api.js';

let db;
let clock;
let profiles;

const at = (iso) => () => new Date(iso);

beforeEach(() => {
  db = openDatabase(':memory:');
  clock = at('2026-09-18T10:00:00Z');
  profiles = createProfiles(db, { now: () => clock() });
});

test('usernames: 3–16 Arabic or Latin letters, digits and _, with at least one letter', () => {
  assert.equal(readUsername('أحمد_99').username, 'أحمد_99');
  assert.equal(readUsername('  Sara  ').username, 'Sara');
  assert.match(readUsername('ab').error, /3/);
  assert.match(readUsername('a'.repeat(17)).error, /16/);
  assert.match(readUsername('two words').error, /مسافات/);
  assert.match(readUsername('12345').error, /حرف/);
  assert.match(readUsername('Admin').error, /محجوز/);
  assert.match(readUsername('وصله').error, /محجوز/);
  assert.match(readUsername('xxFuckxx').error, /آخر/);
});

test('names differing by case, hamza form, ة/ه or digit script are the same name', () => {
  assert.equal(usernameKey('أمل١'), usernameKey('امل1'));
  assert.equal(usernameKey('فاطمة'), usernameKey('فاطمه'));
  assert.equal(usernameKey('SARA'), usernameKey('sara'));
  assert.ok(profiles.create({ username: 'أمل1', avatar: 'paw' }).token);
  const clash = profiles.create({ username: 'امل١', avatar: 'fish' });
  assert.equal(clash.status, 409);
  assert.deepEqual(profiles.checkUsername('AMAL'), { available: true });
  assert.equal(profiles.checkUsername('امل1').available, false);
});

test('a profile is found by its token only, which is not stored', () => {
  const { token, profile } = profiles.create({ username: 'sara', avatar: 'moon' });
  assert.equal(profiles.authenticate(token).id, profile.id);
  assert.equal(profiles.authenticate('x'.repeat(43)), null);
  assert.equal(profiles.authenticate(null), null);
  const row = db.prepare('SELECT * FROM profiles').get();
  assert.ok(!JSON.stringify(row).includes(token));
  assert.equal(profiles.create({ username: 'other', avatar: 'X' }).status, 400);
});

test('stats are checked, the best streak never drops, and badges accumulate', () => {
  assert.match(readStats({ points: -1 }).error, /points/);
  assert.match(readStats({ points: 1, levelsCompleted: 1, wordsSolved: 1, streak: 1, bestStreak: 1, badges: ['BAD ID'] }).error, /badges/);
  const { profile } = profiles.create({ username: 'sara', avatar: 'moon' });
  const base = { points: 100, levelsCompleted: 3, wordsSolved: 20, streak: 5, bestStreak: 2, streakDate: '2026-09-18' };
  profiles.saveStats(profile, readStats({ ...base, badges: ['wasla.words.10'] }).stats);
  const after = profiles.saveStats(profile, readStats({ ...base, streak: 1, bestStreak: 1, badges: ['wasla.levels.10'] }).stats);
  const view = profiles.publicView(after);
  assert.equal(view.stats.bestStreak, 5);
  assert.equal(view.stats.streak, 1);
  assert.deepEqual(view.badges.sort(), ['wasla.levels.10', 'wasla.words.10']);
});

test('a daily time is for a date around today, above the minimum, and the first one stays', () => {
  const today = '2026-09-18';
  assert.match(readDailyTime({ kind: 'allgames', date: '2026-09-16', seconds: 100 }, today).error, /today/);
  assert.match(readDailyTime({ kind: 'allgames', date: today, seconds: 5 }, today).error, /30/);
  assert.match(readDailyTime({ kind: 'nope', date: today, seconds: 50 }, today).error, /kind/);
  assert.ok(readDailyTime({ kind: 'wordsearch', date: '2026-09-19', seconds: 50 }, today).date);
  const { profile } = profiles.create({ username: 'sara', avatar: 'moon' });
  assert.deepEqual(profiles.saveDailyTime(profile, { kind: 'allgames', date: today, seconds: 300 }), { seconds: 300, isNew: true });
  assert.equal(profiles.saveDailyTime(profile, { kind: 'allgames', date: today, seconds: 100 }).seconds, 300);
  profiles.saveDailyTime(profile, { kind: 'wordsearch', date: today, seconds: 80 });
  assert.deepEqual(profiles.ownView(profile).today, { date: today, wordsearchSeconds: 80, allgamesSeconds: 300 });
});

test('boards rank fastest first for times and highest first for points, with my rank beyond the top', () => {
  const players = ['aaa', 'bbb', 'ccc', 'ddd'].map((username, i) => profiles.create({ username, avatar: 'paw' }).profile);
  [400, 200, 300, 200].forEach((seconds, i) => profiles.saveDailyTime(players[i], { kind: 'allgames', date: '2026-09-18', seconds }));
  const board = profiles.leaderboard('today-allgames', { viewer: players[0], limit: 3 });
  assert.deepEqual(board.entries.map((e) => [e.rank, e.username, e.value]), [[1, 'bbb', 200], [2, 'ddd', 200], [3, 'ccc', 300]]);
  assert.deepEqual(board.me, { rank: 4, value: 400 });
  assert.equal(board.total, 4, 'the whole field, not just the page shown');
  assert.equal(board.date, '2026-09-18');
  assert.equal(profiles.leaderboard('today-allgames', { date: '2026-09-17' }).entries.length, 0);

  const stats = (points) => readStats({ points, levelsCompleted: 0, wordsSolved: 0, streak: 0, bestStreak: 0 }).stats;
  profiles.saveStats(players[2], stats(50));
  profiles.saveStats(players[3], stats(90));
  const points = profiles.leaderboard('points', { viewer: players[0] });
  assert.deepEqual(points.entries.map((e) => e.username), ['ddd', 'ccc']);
  assert.equal(points.me, null);
  assert.equal(points.total, 2, 'players with no points are not on the board at all');
});

test('a streak counts only while it is alive, and banned players leave every board', () => {
  const [alive, stale] = ['alive', 'stale'].map((username) => profiles.create({ username, avatar: 'paw' }).profile);
  const stats = (streak, streakDate) => readStats({ points: 10, levelsCompleted: 0, wordsSolved: 0, streak, bestStreak: streak, streakDate }).stats;
  profiles.saveStats(alive, stats(3, '2026-09-17'));
  profiles.saveStats(stale, stats(9, '2026-09-10'));
  assert.deepEqual(profiles.leaderboard('streak').entries.map((e) => e.username), ['alive']);
  assert.equal(profiles.publicView(profiles.get(stale.id)).stats.streak, 0);
  profiles.setBanned(alive.id, true);
  assert.equal(profiles.leaderboard('streak').entries.length, 0);
  assert.equal(profiles.leaderboard('points').entries.length, 1);
  assert.equal(profiles.findByUsername('alive'), null);
});

test('deleting a profile removes its scores and badges', () => {
  const { profile } = profiles.create({ username: 'gone', avatar: 'paw' });
  profiles.saveDailyTime(profile, { kind: 'allgames', date: '2026-09-18', seconds: 100 });
  profiles.saveStats(profile, readStats({ points: 1, levelsCompleted: 0, wordsSolved: 0, streak: 0, bestStreak: 0, badges: ['wasla.words.10'] }).stats);
  assert.equal(profiles.remove(profile), true);
  for (const table of ['profiles', 'profile_daily', 'profile_badges']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
});

// ── HTTP ─────────────────────────────────────────────────────────────────────

let server;
let base;

before(async () => {
  const httpDb = openDatabase(':memory:');
  const app = express();
  const httpProfiles = createProfiles(httpDb);
  app.use('/api/v1', apiRouter({ repo: { publishedLevels: () => [] }, publicUrl: '', profiles: httpProfiles, appConfig: { get: () => ({}) } }));
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});

after(() => server.close());

const call = (path, { method = 'GET', token, body } = {}) => fetch(`${base}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test('HTTP: create, check, update, post a time, read the board, delete', async () => {
  const created = await call('/profiles', { method: 'POST', body: { username: 'لاعب', avatar: 'cactus' } });
  assert.equal(created.status, 201);
  const { token, profile } = await created.json();
  assert.equal(profile.username, 'لاعب');
  assert.ok(token.length >= 40);

  assert.equal((await call('/profiles', { method: 'POST', body: { username: 'لاعب', avatar: 'cactus' } })).status, 409);
  assert.deepEqual(await (await call(`/profiles/check?username=${encodeURIComponent('لاعب')}`, { token })).json(), { available: true });
  assert.equal((await call('/profile/me')).status, 401);

  const renamed = await call('/profile/me', { method: 'PATCH', token, body: { username: 'player_1', avatar: 'moon' } });
  assert.deepEqual([(await renamed.json()).profile.username], ['player_1']);

  const today = new Date().toISOString().slice(0, 10);
  const time = await call('/profile/me/daily', { method: 'POST', token, body: { kind: 'allgames', date: today, seconds: 240 } });
  assert.deepEqual(await time.json(), { seconds: 240, rank: 1 });
  const stats = await call('/profile/me/stats', { method: 'PUT', token, body: { points: 70, levelsCompleted: 2, wordsSolved: 9, streak: 1, bestStreak: 1, streakDate: today, badges: [] } });
  assert.equal(stats.status, 200);

  const board = await (await call(`/leaderboards/today-allgames?date=${today}`, { token })).json();
  assert.deepEqual(board.entries.map((e) => [e.rank, e.username, e.avatar, e.value, e.isMe]), [[1, 'player_1', 'moon', 240, true]]);
  assert.deepEqual(board.me, { rank: 1, value: 240 });
  assert.equal((await call('/leaderboards/nope')).status, 404);

  const open = await (await call('/profiles/PLAYER_1')).json();
  assert.equal(open.profile.stats.points, 70);
  assert.equal(open.profile.token, undefined);

  assert.equal((await call('/profile/me', { method: 'DELETE', token })).status, 204);
  assert.equal((await call('/profile/me', { token })).status, 401);
});

test('a recovery code brings the profile back on another phone, with a new token', () => {
  const { token, recoveryCode, profile } = profiles.create({ username: 'sara', avatar: 'paw' });
  assert.match(recoveryCode, /^WSL-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.ok(!db.prepare('SELECT * FROM profiles').get().recovery_hash.includes(recoveryCode));

  // Typed without hyphens and in lower case: still the same code.
  const recovered = profiles.recover(recoveryCode.replace(/-/g, '').toLowerCase());
  assert.equal(recovered.profile.id, profile.id);
  assert.notEqual(recovered.token, token);
  assert.equal(profiles.authenticate(recovered.token).id, profile.id);
  assert.equal(profiles.authenticate(token), null, 'the old phone signs out');

  assert.equal(profiles.recover('WSL-AAAA-BBBB').status, 404);
  assert.equal(profiles.recover('nope').status, 400);
});

test('a new code replaces the old one, and a banned profile cannot be recovered', () => {
  const { recoveryCode, profile } = profiles.create({ username: 'sara', avatar: 'paw' });
  const fresh = profiles.resetRecoveryCode(profile);
  assert.notEqual(fresh, recoveryCode);
  assert.equal(profiles.recover(recoveryCode).status, 404);
  assert.equal(profiles.recover(fresh).profile.id, profile.id);
  profiles.setBanned(profile.id, true);
  assert.equal(profiles.recover(fresh).status, 403);
});

test('HTTP: create shows the code once, and it recovers the profile later', async () => {
  const created = await (await call('/profiles', { method: 'POST', body: { username: 'recovered', avatar: 'moon' } })).json();
  assert.match(created.recoveryCode, /^WSL-/);
  const back = await (await call('/profiles/recover', { method: 'POST', body: { code: created.recoveryCode } })).json();
  assert.equal(back.profile.username, 'recovered');
  assert.notEqual(back.token, created.token);
  assert.equal((await call('/profiles/recover', { method: 'POST', body: { code: 'WSL-ZZZZ-ZZZZ' } })).status, 404);

  const next = await (await call('/profile/me/recovery-code', { method: 'POST', token: back.token })).json();
  assert.match(next.recoveryCode, /^WSL-/);
  assert.equal((await call('/profiles/recover', { method: 'POST', body: { code: created.recoveryCode } })).status, 404);
});

test('the stars board ranks level stars, which never go down, and older apps without stars still sync', () => {
  const [a, b] = ['aaa', 'bbb'].map((username) => profiles.create({ username, avatar: 'paw' }).profile);
  const stats = (extra) => readStats({ points: 5, levelsCompleted: 1, wordsSolved: 1, streak: 0, bestStreak: 0, ...extra });
  profiles.saveStats(a, stats({ stars: 12 }).stats);
  profiles.saveStats(b, stats({ stars: 30 }).stats);
  profiles.saveStats(b, stats({ stars: 4 }).stats);
  assert.deepEqual(profiles.leaderboard('stars', { viewer: a }).entries.map((e) => [e.username, e.value]), [['bbb', 30], ['aaa', 12]]);
  assert.deepEqual(profiles.leaderboard('stars', { viewer: a }).me, { rank: 2, value: 12 });
  assert.equal(stats({}).stats.stars, 0);
  assert.match(stats({ stars: -1 }).error, /stars/);
  assert.equal(profiles.publicView(profiles.get(b.id)).stats.stars, 30);
});

test('passing a player on today\'s board finds the one just behind, once a day', () => {
  const [slow, mid, fast] = ['slow', 'mid', 'fast'].map((username) => profiles.create({ username, avatar: 'paw' }).profile);
  profiles.saveDailyTime(slow, { kind: 'allgames', date: '2026-09-18', seconds: 500 });
  profiles.saveDailyTime(mid, { kind: 'allgames', date: '2026-09-18', seconds: 300 });
  profiles.saveDailyTime(fast, { kind: 'allgames', date: '2026-09-18', seconds: 200 });
  const first = profiles.claimPassedPlayer(fast, '2026-09-18');
  assert.deepEqual([first.profile.username, first.rank], ['mid', 2]);
  const second = profiles.claimPassedPlayer(fast, '2026-09-18');
  assert.equal(second.profile.username, 'slow', 'mid was told already; the next one down');
  assert.equal(profiles.claimPassedPlayer(slow, '2026-09-18'), null, 'nobody is behind the slowest');
});

test('the best all-games time is the fastest ever and shows on the public profile; boards carry stars', () => {
  const { profile } = profiles.create({ username: 'sara', avatar: 'paw' });
  profiles.saveDailyTime(profile, { kind: 'allgames', date: '2026-09-18', seconds: 400 });
  profiles.saveStats(profile, readStats({ points: 1, levelsCompleted: 0, wordsSolved: 0, streak: 0, bestStreak: 0, stars: 7, bestAllGamesSeconds: 350 }).stats);
  profiles.saveStats(profile, readStats({ points: 1, levelsCompleted: 0, wordsSolved: 0, streak: 0, bestStreak: 0, stars: 7, bestAllGamesSeconds: 900 }).stats);
  assert.equal(profiles.publicView(profiles.get(profile.id)).stats.bestAllGamesSeconds, 350);
  assert.equal(profiles.leaderboard('today-allgames').entries[0].stars, 7);
  assert.match(readStats({ points: 1, levelsCompleted: 0, wordsSolved: 0, streak: 0, bestStreak: 0, bestAllGamesSeconds: 5 }).error, /bestAllGamesSeconds/);
  profiles.linkDevice(profile, 'abcdef12-3456');
  profiles.linkDevice(profile, 'abcdef12-3456');
  assert.deepEqual(profiles.devicesOf(profile.id), ['abcdef12-3456']);
});

test('the push to a passed player names who passed them and their new rank', async () => {
  const { passedMessage } = await import('../src/routes/api-profiles.js');
  assert.deepEqual(passedMessage({ username: 'سارة' }, 372, 3), {
    title: 'وقتك في لغز اليوم تم تجاوزه ⏱️',
    body: 'سارة: 06:12 — أنت الآن #3',
  });
});

test('the seasonal avatars come last, and frames are ramadan and eid', () => {
  assert.equal(AVATARS.length, 73);
  assert.deepEqual(AVATARS.slice(-3), ['fanous', 'eidiya', 'friday-star']);
  assert.equal(new Set(AVATARS).size, AVATARS.length);
  assert.deepEqual(FRAMES, ['ramadan', 'eid']);
  assert.deepEqual(readFrame('eid'), { frame: 'eid' });
  assert.deepEqual(readFrame(null), { frame: null });
  assert.deepEqual(readFrame(''), { frame: null });
  for (const bad of ['gold', 'Ramadan', 1, true, {}]) assert.ok(readFrame(bad).error, String(bad));
});

test('a frame is set, kept through other changes, cleared, and shown on every view and board', () => {
  const { profile } = profiles.create({ username: 'hala', avatar: 'fanous' });
  assert.equal(profiles.ownView(profile).frame, null);

  const framed = profiles.update(profile, { frame: 'ramadan' }).profile;
  assert.equal(framed.frame, 'ramadan');
  assert.equal(profiles.update(framed, { avatar: 'eidiya' }).profile.frame, 'ramadan');
  assert.equal(profiles.publicView(profiles.get(profile.id)).frame, 'ramadan');
  assert.equal(profiles.ownView(profiles.get(profile.id)).frame, 'ramadan');
  profiles.saveDailyTime(profile, { kind: 'allgames', date: '2026-09-18', seconds: 300 });
  assert.equal(profiles.leaderboard('today-allgames').entries[0].frame, 'ramadan');

  const bad = profiles.update(framed, { frame: 'gold' });
  assert.equal(bad.status, 400);
  assert.equal(bad.error, 'اختر إطاراً من القائمة');
  assert.equal(profiles.get(profile.id).frame, 'ramadan');

  assert.equal(profiles.update(framed, { frame: null }).profile.frame, null);
  assert.equal(profiles.leaderboard('today-allgames').entries[0].frame, null);
});

test('HTTP: frames are listed, set and cleared through PATCH, and a bad one is a 400', async () => {
  const frames = await call('/profiles/frames');
  assert.equal(frames.status, 200);
  assert.deepEqual(await frames.json(), { frames: ['ramadan', 'eid'] });
  assert.equal((await (await call('/profiles/avatars')).json()).avatars.length, 73);

  const { token } = await (await call('/profiles', { method: 'POST', body: { username: 'framed', avatar: 'friday-star' } })).json();
  const set = await call('/profile/me', { method: 'PATCH', token, body: { frame: 'eid' } });
  assert.equal((await set.json()).profile.frame, 'eid');
  assert.equal((await (await call('/profile/me', { token })).json()).profile.frame, 'eid');
  assert.equal((await (await call('/profiles/framed')).json()).profile.frame, 'eid');

  const bad = await call('/profile/me', { method: 'PATCH', token, body: { frame: 'gold' } });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'اختر إطاراً من القائمة' });

  const cleared = await call('/profile/me', { method: 'PATCH', token, body: { frame: '' } });
  assert.equal((await cleared.json()).profile.frame, null);
  assert.equal((await call('/profile/me', { method: 'DELETE', token })).status, 204);
});

test('every board the app can ask for has a panel label', async () => {
  const { BOARD_LABELS, clockText } = await import('../src/routes/admin-boards.js');
  for (const board of BOARDS) {
    assert.ok(BOARD_LABELS[board], `${board} is missing from the panel's board labels`);
    assert.ok(BOARD_LABELS[board].ar, `${board} has no Arabic name`);
  }
  assert.equal(Object.keys(BOARD_LABELS).length, BOARDS.length, 'no label is left over from a board that went');
  assert.equal(clockText(0), '0:00');
  assert.equal(clockText(65), '1:05');
  assert.equal(clockText(600), '10:00');
});
