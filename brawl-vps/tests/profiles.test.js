import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  brawlerProfile,
  mapProfile,
  modeProfile,
  rotationSummary,
  teamStats,
  winRateRank,
} from '../src/community/profiles.js';

test('win-rate rank skips brawlers with too few games', () => {
  const rows = [
    { id: 1, decided: 100, wins: 60 },
    { id: 2, decided: 100, wins: 50 },
    { id: 3, decided: 5, wins: 5 },
  ];
  assert.deepEqual(winRateRank(rows, 2), { rank: 2, of: 2 });
  assert.deepEqual(winRateRank(rows, 3), { rank: null, of: 2 });
});

test('brawler profile: ranges, ranked tiers, modes, maps against the mode, build', () => {
  const p = brawlerProfile({
    id: 7,
    totals: [{ id: 7, picks: 200, decided: 100, wins: 55 }, { id: 8, picks: 200, decided: 100, wins: 45 }],
    ranges: [
      { range: '0-499', id: 7, decided: 40, wins: 30 },
      { range: '0-499', id: 8, decided: 40, wins: 20 },
      { range: '1000+', id: 7, decided: 50, wins: 20 },
    ],
    ranked: [{ division: 2, id: 7, decided: 10, wins: 6 }, { division: 22, id: 7, decided: 10, wins: 4 }, { division: 2, id: 8, decided: 9, wins: 1 }],
    modes: [{ mode: 'brawlBall', picks: 50, decided: 50, wins: 25, modePicks: 1000 }],
    maps: [
      { mode: 'brawlBall', map: 'A', picks: 40, decided: 40, wins: 30 },
      { mode: 'brawlBall', map: 'B', picks: 10, decided: 10, wins: 0 }, // too few games
    ],
    daily: [{ day: '2026-11-10', picks: 10, decided: 8, wins: 4 }],
    counters: [
      { kind: 'b.gear', subject: '62000000:SHIELD', n: 3 },
      { kind: 'b.gear', subject: '62000002:DAMAGE', n: 1 },
      { kind: 'b.starpower', subject: '23000076:SHELL SHOCK', n: 2 },
      { kind: 'unlock.brawler', subject: 'X', n: 9 },
    ],
  });
  assert.deepEqual(p.overall, { winRate: 0.55, games: 100, rank: 1, of: 2 });
  assert.deepEqual(p.ranges.map((r) => [r.range, r.winRate, r.rank]), [['0-499', 0.75, 1], ['500-999', 0, null], ['1000+', 0.4, 1]]);
  assert.deepEqual(p.ranked.tiers.map((t) => [t.tier, t.winRate]), [['Bronze', 0.6], ['Pro', 0.4]]);
  assert.equal(p.ranked.winRate, 0.5);
  assert.equal(p.modes[0].useRate, 0.05);
  assert.deepEqual(p.bestMaps.map((m) => [m.map, m.vsMode]), [['A', 0.25]]);
  assert.deepEqual(p.build.gears.map((g) => [g.id, g.name, g.share]), [[62000000, 'SHIELD', 0.75], [62000002, 'DAMAGE', 0.25]]);
  assert.equal(p.build.starPower.name, 'SHELL SHOCK');
  assert.equal(p.unlocks.brawler, 9);
});

test('team stats: confidence-ranked, so a small perfect record does not top a big good one', () => {
  const { top, partnersOf } = teamStats([
    { comp: [1, 2, 3], games: 200, wins: 160 }, // 80%, lower bound ~74%
    { comp: [1, 2, 4], games: 10, wins: 10 }, // 100%, lower bound ~72%
    { comp: [1, 5, 6], games: 4, wins: 4 }, // under the 10-game minimum
  ]);
  assert.deepEqual(top.map((t) => [t.ids, t.winRate]), [[[1, 2, 3], 0.8], [[1, 2, 4], 1]]);
  assert.deepEqual(partnersOf(1).map((p) => p.id), [2, 3, 4]);
});

test('rotation summary: appearances, cadence, live now', () => {
  const now = new Date('2026-11-10T12:00:00Z');
  const r = rotationSummary([
    { mode: 'brawlBall', slot: 55, start: '2026-11-08T10:00:00Z', end: '2026-11-08T12:00:00Z' },
    { mode: 'brawlBall', slot: 55, start: '2026-11-09T10:00:00Z', end: '2026-11-09T12:00:00Z' },
    { mode: 'brawlBall', slot: 55, start: '2026-11-10T11:00:00Z', end: '2026-11-10T13:00:00Z' },
  ], now);
  assert.equal(r.appearances, 3);
  assert.equal(r.liveHours, 6);
  assert.equal(r.cadenceHours, 25); // median of 24 h and 25 h gaps
  assert.equal(r.live, true);
  assert.deepEqual(r.slots, [55]);
});

test('map profile: categories, snapshot, range filter, vs mode', () => {
  const row = (range, id, picks, decided, wins, stars = 0) => ({ range, id, name: `B${id}`, picks, decided, wins, stars });
  const rows = [
    row('0-499', 1, 100, 100, 70, 30), row('1000+', 1, 20, 20, 10),
    row('0-499', 2, 300, 300, 120, 10),
    row('0-499', 3, 30, 30, 25, 9),
    row('0-499', 4, 10, 10, 2),
  ];
  const p = mapProfile({
    map: 'Backyard Bowl', rows, ranked: [], teams: [{ comp: [1, 2, 3], games: 19, wins: 14 }],
    summary: { battles: 150, mode: 'brawlBall', lastAt: null, avgDuration: 90 }, rotations: [],
    modeRows: [{ id: 1, decided: 1000, wins: 500 }],
  });
  assert.equal(p.picks, 460);
  assert.equal(p.confidence, 'low');
  assert.deepEqual(p.winners.map((b) => b.id), [3, 1, 2, 4]);
  assert.equal(p.mostUsed[0].id, 2);
  assert.equal(p.snapshot.trap.id, 2); // most used among below-average win rates
  assert.equal(p.vsMode[0].id, 1);
  assert.ok(Math.abs(p.vsMode[0].gap - (80 / 120 - 0.5)) < 1e-12);
  assert.deepEqual(p.topTeams[0].ids, [1, 2, 3]);
  const high = mapProfile({ map: 'x', range: '1000+', rows, ranked: [], teams: [], summary: { battles: 1, mode: null }, rotations: [], modeRows: [] });
  assert.equal(high.picks, 20);
  assert.equal(high.trophyRanges.find((r) => r.range === '0-499').games, 440);
});

test('mode profile reuses the meta board', () => {
  const p = modeProfile({
    mode: 'brawlBall',
    board: [{ id: 1, name: 'A', picks: 600, decided: 500, wins: 300 }, { id: 2, name: 'B', picks: 400, decided: 400, wins: 160 }],
    ranked: [],
    maps: [{ map: 'Pinball Dreams', battles: 10 }],
    summary: { battles: 10, share: 0.2, avgDuration: 95, maps: 1 },
    daily: [],
  });
  assert.equal(p.meta.bestPicks[0].id, 1);
  assert.equal(p.share, 0.2);
  assert.equal(p.ranked.games, 0);
});
