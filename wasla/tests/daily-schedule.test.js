import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KIND_NAMES, kindForDate, kindForDay, schedule, WEEK, weekdayOf } from '../src/daily-schedule.js';
import { parseDay } from '../src/daily.js';

test('day zero is a Thursday, and the week counts from Sunday', () => {
  assert.equal(weekdayOf(0), 4);
  assert.equal(weekdayOf(parseDay('2026-09-20').day), 0, '2026-09-20 is a Sunday');
  assert.equal(weekdayOf(parseDay('2026-09-26').day), 6, '2026-09-26 is a Saturday');
  for (let day = -400; day < 400; day++) assert.ok(weekdayOf(day) >= 0 && weekdayOf(day) < 7);
});

test('each weekday carries one game, and Friday the marathon', () => {
  assert.deepEqual(WEEK.length, 7);
  assert.equal(kindForDate('2026-09-19'), 'picture', 'Saturday');
  assert.equal(kindForDate('2026-09-20'), 'wordsearch', 'Sunday');
  assert.equal(kindForDate('2026-09-21'), 'guess', 'Monday');
  assert.equal(kindForDate('2026-09-22'), 'wheel', 'Tuesday');
  assert.equal(kindForDate('2026-09-23'), 'guess', 'Wednesday');
  assert.equal(kindForDate('2026-09-24'), 'wordsearch', 'Thursday');
  assert.equal(kindForDate('2026-09-25'), 'marathon', 'Friday');
});

test('every seventh day repeats, and every kind is named', () => {
  for (let day = 0; day < 70; day++) assert.equal(kindForDay(day), kindForDay(day + 7));
  for (const entry of schedule()) assert.equal(entry.title, KIND_NAMES[entry.kind]);
  assert.equal(kindForDate('nonsense'), null);
});
