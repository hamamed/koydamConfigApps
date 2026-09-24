import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { configForApp, createAppConfig, DEFAULT_CONFIG, IOS_TEST_ADS } from '../src/app-config.js';
import { openDatabase } from '../src/db/index.js';

let settings;
let db;

beforeEach(() => {
  db = openDatabase(':memory:');
  settings = createAppConfig(db);
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
    dailyGameCoins: 30,
    dailyAllGamesBonus: 120,
    ads: {
      enabled: false,
      testMode: false,
      appId: '',
      banner: { enabled: true, unitId: '' },
      interstitial: { enabled: true, unitId: '', everyQuestions: 10, minSecondsBetween: 60, maxPerDay: 20 },
      rewarded: { enabled: true, unitId: '', coins: 50, maxPerDay: 5 },
    },
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

// --- Ads (contract §11) -------------------------------------------------

const UNIT = 'ca-app-pub-1234567890123456/1234567890';
const APP_ID = 'ca-app-pub-1234567890123456~1234567890';

/** The ads block with `over` applied on top, inside a whole valid config. */
const withAds = (over) => ({ ...DEFAULT_CONFIG, ads: { ...DEFAULT_CONFIG.ads, ...over } });

test('saves the ad unit ids and the numbers that go with them', () => {
  const result = settings.save(withAds({
    enabled: true,
    appId: APP_ID,
    banner: { enabled: true, unitId: UNIT },
    interstitial: { enabled: true, unitId: UNIT, everyQuestions: 7, minSecondsBetween: 90, maxPerDay: 0 },
    rewarded: { enabled: true, unitId: UNIT, coins: 75, maxPerDay: 3 },
  }));
  assert.equal(result.error, undefined);
  const ads = settings.get().ads;
  assert.equal(ads.enabled, true);
  assert.equal(ads.appId, APP_ID);
  assert.equal(ads.banner.unitId, UNIT);
  assert.equal(ads.interstitial.everyQuestions, 7);
  assert.equal(ads.interstitial.maxPerDay, 0);
  assert.equal(ads.rewarded.coins, 75);
});

test('a form sends switches as "on" and numbers as strings', () => {
  const result = settings.save(withAds({
    enabled: 'on',
    testMode: undefined,
    banner: { enabled: 'on', unitId: `  ${UNIT}  ` },
    interstitial: { enabled: undefined, unitId: '', everyQuestions: '12', minSecondsBetween: '0', maxPerDay: '5' },
    rewarded: { enabled: 'on', unitId: '', coins: '20', maxPerDay: '2' },
  }));
  assert.equal(result.error, undefined);
  const ads = result.config.ads;
  assert.equal(ads.enabled, true);
  assert.equal(ads.testMode, false, 'an unticked box is simply absent');
  assert.equal(ads.banner.unitId, UNIT, 'trimmed');
  assert.equal(ads.interstitial.enabled, false);
  assert.equal(ads.interstitial.everyQuestions, 12);
  assert.equal(ads.rewarded.coins, 20);
});

test('an empty unit id is allowed — it is how a format is left unset', () => {
  assert.equal(settings.save(withAds({ banner: { enabled: true, unitId: '' } })).error, undefined);
  assert.equal(settings.get().ads.banner.unitId, '');
});

test('refuses malformed ids and out-of-range numbers, and changes nothing', () => {
  const bad = [
    { appId: UNIT },                                        // a slash where the app id wants a tilde
    { appId: 'ca-app-pub-123~456' },
    { banner: { enabled: true, unitId: 'ca-app-pub-123/456' } },
    { banner: { enabled: true, unitId: `${UNIT}x` } },
    { interstitial: { ...DEFAULT_CONFIG.ads.interstitial, everyQuestions: 0 } },
    { interstitial: { ...DEFAULT_CONFIG.ads.interstitial, everyQuestions: 101 } },
    { interstitial: { ...DEFAULT_CONFIG.ads.interstitial, minSecondsBetween: -1 } },
    { interstitial: { ...DEFAULT_CONFIG.ads.interstitial, maxPerDay: 201 } },
    { rewarded: { ...DEFAULT_CONFIG.ads.rewarded, coins: 1001 } },
    { rewarded: { ...DEFAULT_CONFIG.ads.rewarded, coins: 2.5 } },
    { rewarded: { ...DEFAULT_CONFIG.ads.rewarded, maxPerDay: 51 } },
    { enabled: 'perhaps' },
  ];
  for (const over of bad) {
    assert.ok(settings.save(withAds(over)).error, JSON.stringify(over));
  }
  assert.deepEqual(settings.get(), DEFAULT_CONFIG);
});

test('an ads row that no longer validates reads as the default', () => {
  settings.save(withAds({ enabled: true }));
  assert.equal(settings.get().ads.enabled, true);
  // As if an older shape were left behind by a downgrade.
  db.prepare(`UPDATE settings SET value = '"nonsense"' WHERE key = 'ads'`).run();
  assert.deepEqual(settings.get().ads, DEFAULT_CONFIG.ads);
});

test('test mode serves Google\'s iOS units to the app and leaves the panel\'s values alone', () => {
  settings.save(withAds({
    enabled: true,
    testMode: true,
    appId: APP_ID,
    banner: { enabled: true, unitId: UNIT },
    interstitial: { ...DEFAULT_CONFIG.ads.interstitial, unitId: UNIT },
    rewarded: { ...DEFAULT_CONFIG.ads.rewarded, unitId: UNIT },
  }));
  const stored = settings.get();
  assert.equal(stored.ads.banner.unitId, UNIT, 'the panel keeps showing what was typed');

  const served = configForApp(stored);
  assert.equal(served.ads.appId, IOS_TEST_ADS.appId);
  assert.equal(served.ads.banner.unitId, IOS_TEST_ADS.banner);
  assert.equal(served.ads.interstitial.unitId, IOS_TEST_ADS.interstitial);
  assert.equal(served.ads.rewarded.unitId, IOS_TEST_ADS.rewarded);
  // Everything else is untouched, the switches and the counts included.
  assert.equal(served.ads.interstitial.everyQuestions, stored.ads.interstitial.everyQuestions);
  assert.equal(served.dailyPuzzleCoins, stored.dailyPuzzleCoins);
});

test('with test mode off the app is served the real ids', () => {
  settings.save(withAds({ enabled: true, banner: { enabled: true, unitId: UNIT } }));
  assert.equal(configForApp(settings.get()).ads.banner.unitId, UNIT);
});
