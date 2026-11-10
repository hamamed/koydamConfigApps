import assert from 'node:assert/strict';
import { test } from 'node:test';

import { eventStats, rankedPool, trophyBreakdown } from '../src/community/events.js';

test('event stats: picks against the map average, use against an even share', () => {
  const s = eventStats({
    battles: 100, avgDuration: 90, confidence: 'medium', averageWinRate: 0.5, sampleBrawlers: 4,
    bestPicks: [{ id: 1, name: 'A', winRate: 0.6 }], mostUsed: [{ id: 2, name: 'B', useRate: 0.4 }],
    topTeams: [{ ids: [1, 2, 3], games: 20, winRate: 0.7 }, {}, {}, {}],
  });
  assert.ok(Math.abs(s.bestPicks[0].delta - 0.1) < 1e-12);
  assert.ok(Math.abs(s.mostUsed[0].delta - 0.15) < 1e-12);
  assert.equal(s.topTeams.length, 3);
  assert.equal(eventStats({ battles: 0 }), null);
  assert.equal(eventStats(null), null);
});

test('trophy breakdown fills every band', () => {
  const t = trophyBreakdown([{ band: 0, n: 5 }, { band: 7, n: 10 }]);
  assert.equal(t.total, 15);
  assert.equal(t.bands.length, 8);
  assert.deepEqual([t.bands[0].n, t.bands[3].n, t.bands[7].label], [5, 0, '1300+']);
});

test('ranked pool groups by map with an All tier and per-tier best picks', () => {
  const pool = rankedPool([
    { map: 'M', mode: 'knockout', tier: 'Gold', id: 1, name: 'A', picks: 60, decided: 60, wins: 40 },
    { map: 'M', mode: 'knockout', tier: 'Gold', id: 2, name: 'B', picks: 60, decided: 60, wins: 20 },
    { map: 'M', mode: 'knockout', tier: 'Pro', id: 1, name: 'A', picks: 6, decided: 6, wins: 6 },
  ]);
  assert.equal(pool.length, 1);
  assert.equal(pool[0].battles, 21);
  assert.deepEqual(Object.keys(pool[0].tiers).sort(), ['All', 'Gold', 'Pro']);
  assert.equal(pool[0].tiers.Gold[0].id, 1);
  assert.ok(Math.abs(pool[0].tiers.Gold[0].delta - (40 / 60 - 0.5)) < 1e-12);
  assert.deepEqual(pool[0].tiers.Pro, []); // under the game minimum
});
