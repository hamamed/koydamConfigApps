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
    timer: { secondsPerWord: 25, bonusCoins: 10 },
    reminderHour: 10,
    starsPerLevel: 2,
    streakFreezeCost: 50,
    wordSearchHelpCosts: { revealLetter: 15, revealWord: 40 },
    dailyGameCoins: 8,
    dailyAllGamesBonus: 30,
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
    { starsPerLevel: 4 },
    { starsPerLevel: -1 },
    { starsPerLevel: 1.5 },
    { starsPerLevel: undefined },
  ];
  for (const over of bad) {
    assert.ok(settings.save({ ...DEFAULT_CONFIG, ...over }).error, JSON.stringify(over));
  }
  assert.deepEqual(settings.get(), DEFAULT_CONFIG);
});

test('stars per level is 0 to 3, 0 opening every level', () => {
  for (const stars of [0, 1, 3, '2']) {
    const result = settings.save({ ...DEFAULT_CONFIG, starsPerLevel: stars });
    assert.equal(result.error, undefined, String(stars));
    assert.equal(result.config.starsPerLevel, Number(stars));
  }
});

test('a stored stars per level that no longer validates reads as the default', () => {
  const db = openDatabase(':memory:');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('starsPerLevel', '9');
  assert.equal(createAppConfig(db).get().starsPerLevel, DEFAULT_CONFIG.starsPerLevel);
});

test('streak freeze cost is 0 to 500 coins, 50 by default, 0 turning it off', () => {
  assert.equal(settings.get().streakFreezeCost, 50);
  for (const cost of [0, 1, 500, '120']) {
    const result = settings.save({ ...DEFAULT_CONFIG, streakFreezeCost: cost });
    assert.equal(result.error, undefined, String(cost));
    assert.equal(result.config.streakFreezeCost, Number(cost));
  }
  for (const cost of [501, -1, 2.5, 'free', undefined]) {
    assert.match(settings.save({ ...DEFAULT_CONFIG, streakFreezeCost: cost }).error, /streak freeze/i, String(cost));
  }
});

test('word search help costs are two whole numbers of coins from 0 to 500', () => {
  assert.deepEqual(settings.get().wordSearchHelpCosts, { revealLetter: 15, revealWord: 40 });
  for (const costs of [{ revealLetter: 0, revealWord: 500 }, { revealLetter: '20', revealWord: '0' }]) {
    const result = settings.save({ ...DEFAULT_CONFIG, wordSearchHelpCosts: costs });
    assert.equal(result.error, undefined, JSON.stringify(costs));
    assert.deepEqual(result.config.wordSearchHelpCosts, { revealLetter: Number(costs.revealLetter), revealWord: Number(costs.revealWord) });
  }
  for (const costs of [{ revealLetter: 501, revealWord: 40 }, { revealLetter: 15, revealWord: -1 }, { revealLetter: 1.5, revealWord: 40 },
    { revealLetter: 15 }, null, 15]) {
    assert.match(settings.save({ ...DEFAULT_CONFIG, wordSearchHelpCosts: costs }).error, /word search/i, JSON.stringify(costs));
  }
  assert.deepEqual(settings.get().wordSearchHelpCosts, { revealLetter: 20, revealWord: 0 });
});

test('a database saved before word search help costs existed reads them as the default', () => {
  const db = openDatabase(':memory:');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('dailyPuzzleCoins', '45');
  const config = createAppConfig(db).get();
  assert.equal(config.dailyPuzzleCoins, 45);
  assert.deepEqual(config.wordSearchHelpCosts, { revealLetter: 15, revealWord: 40 });
});
