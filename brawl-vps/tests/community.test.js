import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clubTimeline,
  compactClub,
  compactProfile,
  diffClubs,
  diffProfiles,
  iconCategory,
  tally,
} from '../src/community/diff.js';
import {
  activity,
  dayRange,
  metaBoard,
  momentum,
  rankedTiers,
  rhythm,
  tierOf,
} from '../src/community/report.js';

const brawler = (over = {}) => ({
  id: 16000000,
  name: 'SHELLY',
  power: 9,
  rank: 20,
  prestigeLevel: 0,
  currentWinStreak: 0,
  gadgets: [{ id: 23000255, name: 'FAST FORWARD' }],
  starPowers: [],
  gears: [{ id: 62000002, name: 'DAMAGE', level: 3 }],
  hyperCharges: [],
  skin: { id: 29000000, name: 'SHELLY' },
  ...over,
});
const player = (brawlers, over = {}) => ({
  tag: '#P1',
  icon: { id: 28000000 },
  expLevel: 100,
  club: { tag: '#C1', name: 'Club' },
  brawlers,
  ...over,
});
const kinds = (events) => events.map((e) => `${e.kind}:${e.id}:${e.subject}`).sort();

test('a first read records state but no events', () => {
  const raw = player([brawler()]);
  assert.deepEqual(diffProfiles(null, compactProfile(raw), raw), []);
});

test('an unchanged profile yields no events', () => {
  const raw = player([brawler()]);
  assert.deepEqual(diffProfiles(compactProfile(raw), compactProfile(raw), raw), []);
});

test('a new brawler is an unlock, not a pile of upgrades', () => {
  const before = player([brawler()]);
  const after = player([brawler(), brawler({ id: 16000090, name: 'VINCE', power: 1, rank: 1 })]);
  assert.deepEqual(kinds(diffProfiles(compactProfile(before), compactProfile(after), after)), [
    'unlock.brawler:16000090:VINCE',
  ]);
});

test('upgrades on an owned brawler each count once, with names from the new read', () => {
  const before = player([brawler()]);
  const after = player(
    [
      brawler({
        power: 11,
        rank: 21,
        prestigeLevel: 1,
        currentWinStreak: 3,
        starPowers: [{ id: 23000076, name: 'SHELL SHOCK' }],
        gears: [{ id: 62000002, name: 'DAMAGE' }, { id: 62000000, name: 'SHIELD' }],
        hyperCharges: [{ id: 23000600, name: 'DOUBLE BARREL' }],
        skin: { id: 29000001, name: 'BANDITA SHELLY' },
      }),
    ],
    { expLevel: 101, icon: { id: 28000014 } },
  );
  assert.deepEqual(kinds(diffProfiles(compactProfile(before), compactProfile(after), after)), [
    'b.gear:16000000:62000000:SHIELD',
    'b.skin:16000000:29000001:BANDITA SHELLY',
    'b.starpower:16000000:23000076:SHELL SHOCK',
    'dist.level:101:101',
    'dist.rank:21:21',
    'icon.drop:28000000:',
    'icon.gain:28000014:',
    'icon.move:0:28000000>28000014',
    'prog.levelup:0:',
    'prog.powerup:16000000:SHELLY',
    'prog.prestige:16000000:SHELLY',
    'prog.rankup:16000000:SHELLY',
    'prog.streak:16000000:SHELLY',
    'skin:29000001:BANDITA SHELLY',
    'unlock.gear:62000000:SHIELD',
    'unlock.hypercharge:16000000:SHELLY',
    'unlock.starpower:23000076:SHELL SHOCK',
  ]);
});

test('a broken streak records its last seen length', () => {
  const before = player([brawler({ currentWinStreak: 7 })]);
  const after = player([brawler({ currentWinStreak: 0 })]);
  assert.deepEqual(kinds(diffProfiles(compactProfile(before), compactProfile(after), after)), [
    'dist.streak:7:7',
    'prog.streakbreak:16000000:SHELLY',
  ]);
});

test('club moves from the player side: join, leave, switch', () => {
  const none = player([], { club: {} });
  const a = player([], { club: { tag: '#A' } });
  const b = player([], { club: { tag: '#B' } });
  const d = (x, y) => kinds(diffProfiles(compactProfile(x), compactProfile(y), y));
  assert.deepEqual(d(none, a), ['club.join:0:']);
  assert.deepEqual(d(a, none), ['club.leave:0:']);
  assert.deepEqual(d(a, b), ['club.switch:0:']);
});

test('club side: arrivals, departures, roles, type and badge', () => {
  const before = compactClub({
    tag: '#C', type: 'open', badgeId: 8000010,
    members: [{ tag: '#1', role: 'member' }, { tag: '#2', role: 'member' }],
  });
  const after = compactClub({
    tag: '#C', type: 'inviteOnly', badgeId: 8000025,
    members: [{ tag: '#1', role: 'senior' }, { tag: '#3', role: 'member' }],
  });
  assert.deepEqual(kinds(diffClubs(before, after)), [
    'club.badge:0:8000010>8000025',
    'club.badge_from:8000010:',
    'club.badge_to:8000025:',
    'club.member_join:0:',
    'club.member_leave:0:',
    'club.role:0:member>senior',
    'club.type:0:open>inviteOnly',
  ]);
});

test('tally merges identical events', () => {
  const rows = tally([
    { kind: 'a', id: 1, subject: 'x' },
    { kind: 'a', id: 1, subject: 'x' },
    { kind: 'b', id: 0, subject: '' },
  ]);
  assert.deepEqual(rows.map((r) => [r.kind, r.events]), [['a', 2], ['b', 1]]);
});

test('icon categories follow the catalog entry', () => {
  assert.equal(iconCategory({ name: 'player_icon_esports_navi' }), 'esports');
  assert.equal(iconCategory({ name: 'player_icon_fame_moon' }), 'fame');
  assert.equal(iconCategory({ name: 'x', brawler: 16000000 }), 'brawler');
  assert.equal(iconCategory({ name: 'x', isAvailableForOffers: true }), 'purchasable');
  assert.equal(iconCategory({ name: 'base1' }), 'other');
  assert.equal(iconCategory(undefined), 'other');
});

test('ranked divisions map to tiers', () => {
  assert.deepEqual([1, 3, 4, 9, 12, 15, 18, 21, 22].map(tierOf), [
    'Bronze', 'Bronze', 'Silver', 'Gold', 'Diamond', 'Mythic', 'Legendary', 'Masters', 'Pro',
  ]);
});

test('meta board measures win and pick rate against the field', () => {
  const board = metaBoard([
    { id: 1, name: 'A', picks: 600, decided: 500, wins: 300 },
    { id: 2, name: 'B', picks: 300, decided: 300, wins: 120 },
    { id: 3, name: 'C', picks: 100, decided: 10, wins: 10 }, // too few decided to rank
  ]);
  assert.equal(board.averageWinRate, 430 / 810);
  assert.deepEqual(board.bestPicks.map((b) => b.id), [1, 2]);
  assert.ok(Math.abs(board.bestPicks[0].delta - (0.6 - 430 / 810)) < 1e-12);
  assert.deepEqual(board.mostUsed.map((b) => [b.id, b.useRate]), [[1, 0.6], [2, 0.3], [3, 0.1]]);
  assert.ok(Math.abs(board.mostUsed[0].delta - (0.6 - 1 / 3)) < 1e-12);
});

test('momentum splits risers and fallers, biggest first', () => {
  const m = momentum([
    { id: 1, name: 'A', now: 0.6, change: 0.1 },
    { id: 2, name: 'B', now: 0.4, change: -0.07 },
    { id: 3, name: 'C', now: 0.55, change: 0.05 },
  ]);
  assert.deepEqual(m.risers.map((r) => r.id), [1, 3]);
  assert.deepEqual(m.fallers.map((r) => r.id), [2]);
});

test('ranked tiers keep the best four with enough games', () => {
  const rows = [
    { division: 2, id: 1, name: 'A', decided: 40, wins: 30, battles: 40 },
    { division: 3, id: 1, name: 'A', decided: 10, wins: 0, battles: 10 },
    { division: 1, id: 2, name: 'B', decided: 100, wins: 50, battles: 100 },
    { division: 1, id: 3, name: 'C', decided: 5, wins: 5, battles: 5 },
    { division: 22, id: 2, name: 'B', decided: 50, wins: 40, battles: 50 },
  ];
  const tiers = rankedTiers(rows);
  assert.deepEqual(tiers.map((t) => t.tier), ['Bronze', 'Pro']);
  assert.deepEqual(tiers[0].top.map((b) => [b.id, b.winRate]), [[1, 0.6], [2, 0.5]]);
  assert.equal(tiers[0].appearances, 155);
});

test('rhythm indexes days to the average and finds the weekend lift', () => {
  // 2026-11-02 is a Monday.
  const days = dayRange('2026-11-02', '2026-11-08').map((day, i) => ({ day, battles: i >= 5 ? 120 : 100 }));
  const r = rhythm(days);
  assert.equal(r.days[0].weekday, 'MON');
  assert.equal(r.peak.weekday, 'SAT');
  assert.equal(r.weekendIndex, 120);
  assert.ok(Math.abs(r.weekendLift - 0.2) < 1e-12);
});

test('activity groups counters into the five tabs', () => {
  const t = (kind, id, subject, n, total, distinct = 1) => ({ kind, id, subject, n, total, distinct });
  const a = activity({
    totals: [
      t('unlock.brawler', 16000090, 'VINCE', 9, 10, 2),
      t('unlock.brawler', 16000091, 'COSMO', 1, 10, 2),
      t('unlock.gear', 62000000, 'SHIELD', 5, 5),
      t('prog.streak', 1, 'GUS', 4, 4),
      t('prog.streakbreak', 1, 'GUS', 5, 5),
      t('club.join', 0, '', 2, 2),
      t('club.leave', 0, '', 4, 4),
      t('icon.gain', 28000014, '', 3, 3),
      t('icon.drop', 28000000, '', 3, 3),
      t('icon.move', 0, '28000000>28000014', 3, 3, 40),
    ],
    daily: [{ day: '2026-11-09', kind: 'unlock.brawler', n: 10 }],
    days: ['2026-11-09', '2026-11-10'],
    iconCatalog: { 28000014: { name: 'player_icon_esports_navi' } },
    trackingSince: '2026-11-09',
  });
  assert.equal(a.ready, true);
  assert.equal(a.events, 15 + 4 + 6 + 3); // streak breaks are not progression
  assert.equal(a.unlocks.top.brawler[0].name, 'VINCE');
  assert.equal(a.unlocks.top.brawler[0].share, 0.9);
  assert.deepEqual(a.unlocks.daily, [
    { day: '2026-11-09', starpower: 0, gadget: 0, hypercharge: 0, gear: 0, brawler: 10 },
    { day: '2026-11-10', starpower: 0, gadget: 0, hypercharge: 0, gear: 0, brawler: 0 },
  ]);
  assert.equal(a.progression.streaks.ratio, 0.8);
  assert.equal(a.club.playersToClubs.ratio, 0.5);
  assert.equal(a.club.net.membership, -2);
  assert.equal(a.icons.categories.find((c) => c.key === 'esports').gained, 3);
  assert.equal(a.icons.transitions.more, 39);
  assert.deepEqual(a.icons.transitions.rows[0], { from: '28000000', to: '28000014', n: 3, share: 1 });
});

test('no counters means not ready rather than zero shares pretending to be data', () => {
  const a = activity({ totals: [], daily: [], days: ['2026-11-10'], iconCatalog: {}, trackingSince: null });
  assert.equal(a.ready, false);
  assert.equal(a.events, 0);
});

test('buffies count when one turns on, against the brawler', () => {
  const before = player([brawler({ buffies: { gadget: false, starPower: false, hyperCharge: false } })]);
  const after = player([brawler({ buffies: { gadget: true, starPower: false, hyperCharge: false } })]);
  assert.deepEqual(kinds(diffProfiles(compactProfile(before), compactProfile(after), after)), ['b.buffie:16000000:gadget']);
});

test('an older stored tuple without buffies still diffs', () => {
  const before = compactProfile(player([brawler()]));
  before.brawlers[16000000] = before.brawlers[16000000].slice(0, 9);
  const after = player([brawler({ buffies: { gadget: true } })]);
  assert.deepEqual(kinds(diffProfiles(before, compactProfile(after), after)), ['b.buffie:16000000:gadget']);
});

test('club timeline names who joined, left and changed role, plus club setting changes', () => {
  const before = compactClub({ tag: '#C', type: 'open', badgeId: 1, requiredTrophies: 1000, description: 'a',
    members: [{ tag: '#1', name: 'Ann', role: 'member' }, { tag: '#2', name: 'Bob', role: 'member' }] });
  const after = compactClub({ tag: '#C', type: 'closed', badgeId: 2, requiredTrophies: 2000, description: 'b',
    members: [{ tag: '#1', name: 'Ann', role: 'senior' }, { tag: '#3', name: 'Cy', role: 'member' }] });
  assert.deepEqual(clubTimeline(before, after).map((e) => `${e.kind}:${e.subject}:${e.detail}`).sort(), [
    'badge::1>2', 'description::b', 'join:Cy:#3', 'leave:Bob:#2', 'required::1000>2000', 'role:Ann:member>senior', 'type::open>closed',
  ]);
  assert.deepEqual(clubTimeline(null, after), []);
});
