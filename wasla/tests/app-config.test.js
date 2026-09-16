import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { createAppConfig, DEFAULT_CONFIG } from '../src/app-config.js';
import { openDatabase } from '../src/db/index.js';

let settings;

beforeEach(() => {
  settings = createAppConfig(openDatabase(':memory:'));
});

test('starts from the contract defaults', () => {
  assert.deepEqual(settings.get(), {
    dailyRewards: [10, 15, 20, 25, 30, 40, 60],
    dailyPuzzleCoins: 30,
    streakBonusPerDay: 5,
    streakBonusMax: 50,
    timer: { secondsPerWord: 25, bonusCoins: 15 },
    reminderHour: 10,
  });
  assert.deepEqual(settings.get(), DEFAULT_CONFIG);
});

test('saves validated numbers and reads them back', () => {
  const next = { ...DEFAULT_CONFIG, dailyRewards: [1, 2, 3, 4, 5, 6, 7], reminderHour: 20, timer: { secondsPerWord: 30, bonusCoins: 0 } };
  assert.equal(settings.save(next).error, undefined);
  assert.deepEqual(settings.get(), next);
});

test('accepts numbers written as strings, as a form sends them', () => {
  const result = settings.save({ ...DEFAULT_CONFIG, dailyPuzzleCoins: '45' });
  assert.equal(result.config.dailyPuzzleCoins, 45);
});

test('refuses values that are not whole numbers in range, and changes nothing', () => {
  const bad = [
    { dailyRewards: [1, 2, 3] },
    { dailyRewards: [1, 2, 3, 4, 5, 6, -1] },
    { dailyPuzzleCoins: 'lots' },
    { streakBonusPerDay: 2.5 },
    { reminderHour: 24 },
    { timer: { secondsPerWord: 0, bonusCoins: 15 } },
  ];
  for (const over of bad) {
    assert.ok(settings.save({ ...DEFAULT_CONFIG, ...over }).error, JSON.stringify(over));
  }
  assert.deepEqual(settings.get(), DEFAULT_CONFIG);
});
