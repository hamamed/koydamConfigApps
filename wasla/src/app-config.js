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
  dailyGameCoins: 8,
  dailyAllGamesBonus: 30,
});

export const REWARD_DAYS = 7;
export const MAX_STARS_PER_LEVEL = 3;
const MAX_COINS = 100_000;
export const MAX_STREAK_FREEZE_COST = 500;
export const MAX_WORD_SEARCH_HELP_COST = 500;

/** A whole number in [min, max] from a number or a numeric string, else null. */
function whole(value, min, max) {
  if (typeof value === 'string' && !/^\s*-?\d+\s*$/.test(value)) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
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
};

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
