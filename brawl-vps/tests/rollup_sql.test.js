import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import pg from 'pg';

// No Postgres here: the pool's query and connect are replaced with a recorder,
// so these tests pin down *which* SQL each path sends and with what — the
// routing between rollups and raw, and the shape of one day's rollup. Whether
// the SQL runs is for a real database; see the coordinator notes.
process.env.BRAWL_API_TOKEN ??= 'test-token';
process.env.POSTGRES_URL = 'postgres://fake:fake@127.0.0.1:1/fake';
process.env.ANALYTICS_SOURCE = 'battles';
process.env.LOG_LEVEL = 'error';

let sent = [];
let rolledDaysFor = () => [];
let rollupRunsFails = false;

function respond(text, params) {
  sent.push({ text, params });
  if (text.includes('FROM rollup_runs')) {
    if (rollupRunsFails) throw new Error('relation "rollup_runs" does not exist');
    return { rows: rolledDaysFor().map((day) => ({ day, source: 'battle_players' })) };
  }
  return { rows: [], rowCount: 0 };
}

pg.Pool.prototype.query = async function fakeQuery(text, params) {
  return respond(text, params);
};
pg.Pool.prototype.connect = async function fakeConnect() {
  return {
    query: async (text, params) => respond(text, params),
    release: () => {},
  };
};

const { brawlerSynergy, brawlerCounters, trophyBrackets } =
  await import('../src/db/analytics_repo.js');
const { rollupDay, daysBetween, utcDay, windowStartDay } =
  await import('../src/db/rollup_repo.js');

const everyDay = (hours) => () => daysBetween(windowStartDay(hours), utcDay());
const allButToday = (hours) => () => everyDay(hours)().slice(0, -1);
const last = (needle) => sent.filter((s) => s.text.includes(needle)).at(-1);

beforeEach(() => {
  sent = [];
  rollupRunsFails = false;
});

test('a fully rolled week is served from the rollups, from the rounded-down start day', async () => {
  rolledDaysFor = everyDay(168);

  await brawlerSynergy({ hours: 168, mode: 'gemGrab', map: 'Hard Rock Mine', minSample: 30, limit: 60 });
  await brawlerCounters(16000000, { hours: 168, minSample: 25, limit: 40 });
  await trophyBrackets({ hours: 168, minSample: 20 });

  assert.deepEqual(last('FROM pair_stats_daily').params,
    [windowStartDay(168), 'gemGrab', 'Hard Rock Mine', 30, 60]);
  assert.deepEqual(last('FROM matchup_stats_daily').params,
    [16000000, windowStartDay(168), null, null, 25, 40]);
  assert.deepEqual(last('FROM bracket_stats_daily').params,
    [windowStartDay(168), null, null, 20]);
  assert.equal(sent.filter((s) => s.text.includes('WITH recent')).length, 0);
});

test('a short window with a missing day goes to the raw tables', async () => {
  rolledDaysFor = allButToday(24);

  await brawlerSynergy({ hours: 24 });
  await brawlerCounters(16000000, { hours: 24 });

  assert.equal(sent.filter((s) => s.text.includes('FROM pair_stats_daily')).length, 0);
  assert.equal(sent.filter((s) => s.text.includes('WITH recent')).length, 2);
});

test('a long window with a missing day is served partially from the rollups rather than timing out', async () => {
  rolledDaysFor = allButToday(168);

  await brawlerCounters(16000000, { hours: 168 });

  assert.ok(last('FROM matchup_stats_daily'));
  assert.equal(sent.filter((s) => s.text.includes('WITH recent')).length, 0);
});

test('an unreadable rollup_runs falls back to the raw tables at any window', async () => {
  rollupRunsFails = true;

  await brawlerSynergy({ hours: 168 });

  assert.equal(sent.filter((s) => s.text.includes('FROM pair_stats_daily')).length, 0);
  assert.ok(last('WITH recent'));
});

test('one day rolls in one transaction: bounded copy, replace, bookkeeping', async () => {
  const summary = await rollupDay('2026-11-08');

  const texts = sent.map((s) => s.text.trim().split(/\s+/).slice(0, 3).join(' '));
  assert.equal(texts[0], 'BEGIN');
  assert.equal(texts.at(-1), 'COMMIT');

  const copy = last('INSERT INTO rollup_day');
  assert.deepEqual(copy.params, ['2026-11-08T00:00:00Z', '2026-11-09T00:00:00Z']);
  assert.ok(copy.text.includes('b.battle_time >= $1::timestamptz'), 'joined side bounded');

  const order = [
    'SET LOCAL statement_timeout',
    'CREATE TEMP TABLE rollup_day',
    'INSERT INTO rollup_day',
    'ANALYZE rollup_day',
    'DELETE FROM pair_stats_daily',
    'INSERT INTO pair_stats_daily',
    'INSERT INTO matchup_stats_daily',
    'INSERT INTO bracket_stats_daily',
    'INSERT INTO rollup_runs',
  ].map((needle) => sent.findIndex((s) => s.text.includes(needle)));
  assert.ok(order.every((i) => i > 0), `all statements sent: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in order');

  assert.equal(summary.day, '2026-11-08');
  assert.equal(summary.source, 'battle_players');
});
