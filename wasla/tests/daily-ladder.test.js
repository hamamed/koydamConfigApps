import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAppConfig } from '../src/app-config.js';
import { ladderFor, LADDER_KINDS, LADDER_RUNGS, rungsFor } from '../src/daily-ladder.js';
import { createDailyGames } from '../src/daily-games.js';
import { kindForDate } from '../src/daily-schedule.js';
import { openDatabase } from '../src/db/index.js';
import { createProfiles } from '../src/profiles.js';
import { createRepository } from '../src/repository.js';

const ALL = Object.fromEntries(LADDER_KINDS.map((kind) => [kind, { kind }]));
const day = (date) => Math.floor(Date.UTC(...date.split('-').map(Number).map((n, i) => (i === 1 ? n - 1 : n))) / 86_400_000);

test('a day is five rungs, each game once, and the day’s own game on top', () => {
  for (const date of ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-26']) {
    const rungs = rungsFor(day(date));
    assert.equal(rungs.length, LADDER_RUNGS, date);
    assert.equal(new Set(rungs).size, LADDER_RUNGS, 'no game twice');
    const own = kindForDate(date);
    if (LADDER_KINDS.includes(own)) assert.equal(rungs.at(-1), own, `${date} climbs to its own game`);
  }
});

test('the days do not all start the same way', () => {
  const starts = new Set(['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23'].map((d) => rungsFor(day(d))[0]));
  assert.ok(starts.size > 1);
});

test('a ladder says what each rung pays, and what the whole climb is worth', () => {
  const ladder = ladderFor('2026-09-23', { games: ALL, coins: 8, bonus: 30 });
  assert.equal(ladder.date, '2026-09-23');
  assert.deepEqual(ladder.rungs.map((rung) => rung.step), [1, 2, 3, 4, 5]);
  assert.ok(ladder.rungs.every((rung) => rung.coins === 8));
  assert.equal(ladder.stars, 15, 'three stars a rung');
  assert.equal(ladder.bonus, 30);
  assert.equal(ladderFor('nonsense', { games: ALL }), null);
});

test('a day that cannot build a game is a shorter ladder, not a broken one', () => {
  const thin = ladderFor('2026-09-23', { games: { bubbles: {}, guess: {} }, coins: 8, bonus: 30 });
  assert.deepEqual(thin.rungs.map((rung) => rung.kind).sort(), ['bubbles', 'guess']);
  assert.equal(thin.stars, 6);
  assert.equal(ladderFor('2026-09-23', { games: {} }), null);
});

test('the set the app reads carries the day’s ladder', () => {
  const db = openDatabase(':memory:');
  const repo = createRepository(db);
  [['أداة للكتابة', 'قلم'], ['من يعلّم', 'معلم'], ['يُكتب فيه', 'دفتر'], ['يجلس عليه', 'مقعد'],
    ['يمحو الخطأ', 'ممحاة'], ['يُقرأ', 'كتاب']].forEach(([clue, answer]) => repo.createQuestion({ title: 'مدرسة', answer, clue }));
  const set = createDailyGames(db, { appConfig: createAppConfig(db) }).forDate('2026-09-23');
  assert.ok(set.ladder.rungs.length >= 1);
  assert.ok(set.ladder.rungs.every((rung) => LADDER_KINDS.includes(rung.kind)));
  assert.equal(set.ladder.rungs[0].coins, set.coins, 'a rung pays what a day’s game pays');
});

test('the day’s board ranks the climb by stars, then by time', () => {
  const db = openDatabase(':memory:');
  const profiles = createProfiles(db);
  const date = profiles.today();
  const climb = (name, stars, seconds) => {
    const { profile } = profiles.create({ username: name, avatar: 'moon' });
    profiles.saveDailyTime(profile, { kind: 'ladder', date, seconds, stars });
    return profile;
  };
  climb('slow_fifteen', 15, 600);
  const quick = climb('quick_fifteen', 15, 300);
  climb('quick_twelve', 12, 120);

  const board = profiles.leaderboard('today-ladder', { date, viewer: quick });
  assert.deepEqual(board.entries.map((e) => [e.rank, e.username, e.value, e.seconds]), [
    [1, 'quick_fifteen', 15, 300],
    [2, 'slow_fifteen', 15, 600],
    [3, 'quick_twelve', 12, 120],
  ], 'more stars first, and the faster of equal stars ahead');
  assert.deepEqual(board.me, { rank: 1, value: 15, seconds: 300 });
  assert.equal(board.total, 3);
});

test('a climb keeps the first one sent, stars and time together', () => {
  const db = openDatabase(':memory:');
  const profiles = createProfiles(db);
  const date = profiles.today();
  const { profile } = profiles.create({ username: 'climber', avatar: 'moon' });

  const first = profiles.saveDailyTime(profile, { kind: 'ladder', date, seconds: 300, stars: 12 });
  assert.deepEqual([first.seconds, first.isNew], [300, true]);
  const again = profiles.saveDailyTime(profile, { kind: 'ladder', date, seconds: 200, stars: 15 });
  assert.deepEqual([again.seconds, again.isNew], [300, false], 'the day is climbed once');
  assert.equal(profiles.leaderboard('today-ladder', { date }).entries[0].value, 12, 'and keeps that climb’s stars');
});
