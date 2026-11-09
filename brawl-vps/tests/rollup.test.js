import assert from 'node:assert/strict';
import { test } from 'node:test';

// config.js refuses to load without a token, and these tests must never reach
// a database — so both are settled before the modules are imported.
process.env.BRAWL_API_TOKEN ??= 'test-token';
delete process.env.POSTGRES_URL;

const { addDays, bracketCase, daysBetween, utcDay, windowStartDay } =
  await import('../src/db/rollup_repo.js');
const { BACKFILL_DAYS, planTick } = await import('../src/analytics/rollup.js');

const NOON = Date.parse('2026-11-09T12:00:00Z');
const JUST_AFTER_MIDNIGHT = Date.parse('2026-11-09T00:30:00Z');

test('days are UTC calendar days and cross month and year boundaries', () => {
  assert.equal(utcDay(NOON), '2026-11-09');
  assert.equal(addDays('2026-11-01', -1), '2026-10-31');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.deepEqual(daysBetween('2026-10-30', '2026-11-02'), [
    '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02',
  ]);
  assert.deepEqual(daysBetween('2026-11-02', '2026-11-01'), []);
});

test('a rollup window starts at the requested start rounded down to midnight, never later', () => {
  // A week asked at noon reads seven full days plus today.
  assert.equal(windowStartDay(168, NOON), '2026-11-02');
  // A day asked just after midnight still reads all of yesterday, not 30 minutes.
  assert.equal(windowStartDay(24, JUST_AFTER_MIDNIGHT), '2026-11-08');
  assert.equal(windowStartDay(1, JUST_AFTER_MIDNIGHT), '2026-11-08');
  assert.equal(windowStartDay(720, NOON), '2026-10-10');
});

test('the backfill covers exactly what a default week-long read needs', () => {
  const today = utcDay(NOON);
  assert.equal(addDays(today, -(BACKFILL_DAYS - 1)), windowStartDay(168, NOON));
});

test('the initial tick rolls today plus every day never rolled or rolled from the other source, newest first', () => {
  const rolled = new Map([
    ['2026-11-09', 'battle_players'],
    ['2026-11-07', 'battle_players'],
    ['2026-11-05', 'battle_samples'],
  ]);
  const plan = planTick({
    today: '2026-11-09',
    rolled,
    source: 'battle_players',
    rotationIndex: 0,
    initial: true,
  });
  assert.deepEqual(plan, [
    '2026-11-09', '2026-11-08', '2026-11-06', '2026-11-05',
    '2026-11-04', '2026-11-03', '2026-11-02',
  ]);
});

test('a scheduled tick re-rolls today, yesterday, one rotating older day and anything missing', () => {
  const today = '2026-11-09';
  const all = new Map(
    daysBetween('2026-11-02', today).map((d) => [d, 'battle_players']),
  );

  const first = planTick({ today, rolled: all, source: 'battle_players', rotationIndex: 0, initial: false });
  assert.deepEqual(first, ['2026-11-09', '2026-11-08', '2026-11-07']);

  // The rotation walks back through the older days and wraps.
  const sixth = planTick({ today, rolled: all, source: 'battle_players', rotationIndex: 5, initial: false });
  assert.deepEqual(sixth, ['2026-11-09', '2026-11-08', '2026-11-02']);
  const seventh = planTick({ today, rolled: all, source: 'battle_players', rotationIndex: 6, initial: false });
  assert.deepEqual(seventh, ['2026-11-09', '2026-11-08', '2026-11-07']);

  const gap = new Map(all);
  gap.delete('2026-11-04');
  const retry = planTick({ today, rolled: gap, source: 'battle_players', rotationIndex: 0, initial: false });
  assert.deepEqual(retry, ['2026-11-09', '2026-11-08', '2026-11-07', '2026-11-04']);
});

test('raw and rollup bucket trophies with one definition', () => {
  const sql = bracketCase('t');
  for (const b of ["'0-299'", "'300-499'", "'500-699'", "'700-999'", "'1000+'"]) {
    assert.ok(sql.includes(b), b);
  }
});
