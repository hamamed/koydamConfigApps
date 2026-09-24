/**
 * Game tuning the app reads at launch (GET /api/v1/config), edited on the
 * Settings page.
 *
 * One row per top-level key, holding JSON. A key without a row, or with a row
 * that no longer validates, reads as its default — the app always gets a
 * complete object.
 */

export const DEFAULT_CONFIG = Object.freeze({
  dailyRewards: Object.freeze([10, 15, 20, 25, 30, 40, 60]),
  dailyPuzzleCoins: 30,
  streakBonusPerDay: 5,
  streakBonusMax: 50,
  timer: Object.freeze({ secondsPerWord: 25, bonusCoins: 10 }),
  reminderHour: 10,
  starsPerLevel: 2,
  streakFreezeCost: 50,
  wordSearchHelpCosts: Object.freeze({ revealLetter: 15, revealWord: 40 }),
  dailyGameCoins: 30,
  dailyAllGamesBonus: 120,
  ads: Object.freeze({
    enabled: false,
    testMode: false,
    appId: '',
    banner: Object.freeze({ enabled: true, unitId: '' }),
    interstitial: Object.freeze({
      enabled: true, unitId: '', everyQuestions: 10, minSecondsBetween: 60, maxPerDay: 20,
    }),
    rewarded: Object.freeze({ enabled: true, unitId: '', coins: 50, maxPerDay: 5 }),
  }),
});

export const REWARD_DAYS = 7;
export const MAX_STARS_PER_LEVEL = 3;
const MAX_COINS = 100_000;
export const MAX_STREAK_FREEZE_COST = 500;
export const MAX_WORD_SEARCH_HELP_COST = 500;

/** Ads (contract §11). A cap of 0 means "no cap"; `enabled` is the off switch. */
export const MAX_ADS_EVERY_QUESTIONS = 100;
export const MAX_ADS_SECONDS_BETWEEN = 3600;
export const MAX_ADS_PER_DAY = 200;
export const MAX_REWARDED_PER_DAY = 50;
export const MAX_REWARDED_COINS = 1000;

/**
 * An AdMob ad unit id, or '' for "not set yet" — which turns that format off in
 * the app however the switches are left, so a half-filled panel never asks the
 * SDK to load nothing.
 */
const AD_UNIT = /^ca-app-pub-\d{16}\/\d{10}$/;

/** The AdMob app id — a tilde, not a slash. Same shape platform-api checks. */
const AD_APP_ID = /^ca-app-pub-\d{16}~\d{10}$/;

/**
 * Google's own iOS test units, which always fill.
 *
 * With «وضع الاختبار» on, these are what the app is served in place of the real
 * ids — the layout and the counters are exercised without serving a real advert
 * and without risking the AdMob account. Same ids as platform-api/src/ads.js.
 */
export const IOS_TEST_ADS = Object.freeze({
  appId: 'ca-app-pub-3940256099942544~1458002511',
  // The ADAPTIVE banner unit, not the fixed-size one: the app asks for an
  // anchored adaptive size, and the fixed-size test unit answers that with a
  // 728x90 leaderboard creative that spills out of the card it sits in.
  banner: 'ca-app-pub-3940256099942544/2435281174',
  interstitial: 'ca-app-pub-3940256099942544/4411468910',
  rewarded: 'ca-app-pub-3940256099942544/1712485313',
});

/** A whole number in [min, max] from a number or a numeric string, else null. */
function whole(value, min, max) {
  if (typeof value === 'string' && !/^\s*-?\d+\s*$/.test(value)) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** A checkbox: absent is false, anything unrecognisable is null. */
function flag(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value === undefined || value === null) return false;
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (['on', 'true', '1', 'yes'].includes(text)) return true;
  if (['', 'off', 'false', '0', 'no'].includes(text)) return false;
  return null;
}

/** An ad unit id, trimmed; '' when the field was left empty. */
function adUnit(value) {
  return adIdentifier(value, AD_UNIT);
}

/** The AdMob app id, trimmed; '' when the field was left empty. */
function adAppId(value) {
  return adIdentifier(value, AD_APP_ID);
}

function adIdentifier(value, pattern) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' || pattern.test(text) ? text : null;
}

/** Each key's validator: the clean value, or null when it is not acceptable. */
const FIELDS = {
  dailyRewards: (v) => {
    if (!Array.isArray(v) || v.length !== REWARD_DAYS) return null;
    const list = v.map((x) => whole(x, 0, MAX_COINS));
    return list.includes(null) ? null : list;
  },
  dailyPuzzleCoins: (v) => whole(v, 0, MAX_COINS),
  streakBonusPerDay: (v) => whole(v, 0, MAX_COINS),
  streakBonusMax: (v) => whole(v, 0, MAX_COINS),
  timer: (v) => {
    const secondsPerWord = whole(v?.secondsPerWord, 1, 600);
    const bonusCoins = whole(v?.bonusCoins, 0, MAX_COINS);
    return secondsPerWord === null || bonusCoins === null ? null : { secondsPerWord, bonusCoins };
  },
  reminderHour: (v) => whole(v, 0, 23),
  // Level N needs (N − 1) × this many stars in total; 0 opens every level.
  starsPerLevel: (v) => whole(v, 0, MAX_STARS_PER_LEVEL),
  // Coins to keep a streak after missing one day; 0 turns the feature off.
  streakFreezeCost: (v) => whole(v, 0, MAX_STREAK_FREEZE_COST),
  // Coins for the two word-search helps; 0 hides that help in the app.
  wordSearchHelpCosts: (v) => {
    const revealLetter = whole(v?.revealLetter, 0, MAX_WORD_SEARCH_HELP_COST);
    const revealWord = whole(v?.revealWord, 0, MAX_WORD_SEARCH_HELP_COST);
    return revealLetter === null || revealWord === null ? null : { revealLetter, revealWord };
  },
  // Coins for each of the five daily games (contract §6), once per date.
  dailyGameCoins: (v) => whole(v, 0, MAX_COINS),
  // Once per date, for finishing the word search and all five games.
  dailyAllGamesBonus: (v) => whole(v, 0, MAX_COINS),
  // Ads (contract §11): the unit ids and every number the app counts against.
  ads: (v) => {
    const enabled = flag(v?.enabled);
    const testMode = flag(v?.testMode);
    const appId = adAppId(v?.appId);
    const banner = {
      enabled: flag(v?.banner?.enabled),
      unitId: adUnit(v?.banner?.unitId),
    };
    const interstitial = {
      enabled: flag(v?.interstitial?.enabled),
      unitId: adUnit(v?.interstitial?.unitId),
      everyQuestions: whole(v?.interstitial?.everyQuestions, 1, MAX_ADS_EVERY_QUESTIONS),
      minSecondsBetween: whole(v?.interstitial?.minSecondsBetween, 0, MAX_ADS_SECONDS_BETWEEN),
      maxPerDay: whole(v?.interstitial?.maxPerDay, 0, MAX_ADS_PER_DAY),
    };
    const rewarded = {
      enabled: flag(v?.rewarded?.enabled),
      unitId: adUnit(v?.rewarded?.unitId),
      coins: whole(v?.rewarded?.coins, 0, MAX_REWARDED_COINS),
      maxPerDay: whole(v?.rewarded?.maxPerDay, 0, MAX_REWARDED_PER_DAY),
    };
    const parts = [enabled, testMode, appId,
      ...Object.values(banner), ...Object.values(interstitial), ...Object.values(rewarded)];
    return parts.includes(null) ? null : { enabled, testMode, appId, banner, interstitial, rewarded };
  },
};

const MESSAGES = {
  dailyRewards: `Daily rewards need ${REWARD_DAYS} whole numbers of coins, none negative.`,
  dailyPuzzleCoins: 'Daily puzzle coins must be a whole number, 0 or more.',
  streakBonusPerDay: 'Streak bonus per day must be a whole number, 0 or more.',
  streakBonusMax: 'The streak bonus cap must be a whole number, 0 or more.',
  timer: 'The timer needs 1 to 600 seconds per word and a whole number of bonus coins.',
  reminderHour: 'The reminder hour is a whole number from 0 to 23.',
  starsPerLevel: `Stars per level is a whole number from 0 to ${MAX_STARS_PER_LEVEL}.`,
  streakFreezeCost: `The streak freeze cost is a whole number of coins from 0 to ${MAX_STREAK_FREEZE_COST}.`,
  wordSearchHelpCosts: `Each word search help costs a whole number of coins from 0 to ${MAX_WORD_SEARCH_HELP_COST}.`,
  dailyGameCoins: 'Daily game coins must be a whole number, 0 or more.',
  dailyAllGamesBonus: 'The all-games bonus must be a whole number, 0 or more.',
  ads: 'تحقّق من إعدادات الإعلانات: معرّف الوحدة يُكتب ca-app-pub-…/… أو يُترك فارغاً، '
    + `والفاصل من ١ إلى ${MAX_ADS_EVERY_QUESTIONS} سؤالاً، والمهلة من ٠ إلى ${MAX_ADS_SECONDS_BETWEEN} ثانية، `
    + `والحد اليومي من ٠ إلى ${MAX_ADS_PER_DAY} (٠ = بلا حد)، وعملات الفيديو من ٠ إلى ${MAX_REWARDED_COINS}.`,
};

/**
 * What `GET /api/v1/config` serves: the stored numbers, with Google's iOS test
 * units swapped in while test mode is on. The panel keeps showing what was
 * typed — the substitution is for the app alone, so turning test mode off
 * restores the real ids without retyping them.
 */
export function configForApp(config) {
  const ads = config?.ads;
  if (!ads?.testMode) return config;
  return {
    ...config,
    ads: {
      ...ads,
      appId: IOS_TEST_ADS.appId,
      banner: { ...ads.banner, unitId: IOS_TEST_ADS.banner },
      interstitial: { ...ads.interstitial, unitId: IOS_TEST_ADS.interstitial },
      rewarded: { ...ads.rewarded, unitId: IOS_TEST_ADS.rewarded },
    },
  };
}

export function createAppConfig(db) {
  function get() {
    const stored = new Map(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
    const config = {};
    for (const [key, check] of Object.entries(FIELDS)) {
      let value = null;
      try {
        value = stored.has(key) ? check(JSON.parse(stored.get(key))) : null;
      } catch {
        value = null; // unreadable JSON reads as the default, like a missing row
      }
      config[key] = value ?? structuredClone(DEFAULT_CONFIG[key]);
    }
    return config;
  }

  /** Validates every key, then writes all or nothing. */
  function save(input) {
    const clean = {};
    for (const [key, check] of Object.entries(FIELDS)) {
      const value = check(input?.[key]);
      if (value === null) return { error: MESSAGES[key] };
      clean[key] = value;
    }
    if (clean.streakBonusMax < clean.streakBonusPerDay) {
      return { error: 'أقصى مكافأة للسلسلة لا يمكن أن يقل عن مكافأة اليوم الواحد.' };
    }
    const write = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`);
    db.transaction(() => {
      for (const [key, value] of Object.entries(clean)) write.run(key, JSON.stringify(value));
    })();
    return { config: get() };
  }

  return { get, save };
}
