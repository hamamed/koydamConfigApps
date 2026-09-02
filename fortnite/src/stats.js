import { config } from './config.js';
import { db } from './db/index.js';
import { setting } from './settings.js';

const BASE = 'https://fortnite-api.com/v2/stats/br/v2';

export const STATS_KEY = 'fortnite_api_key';

/** Thrown with a `status` so a route can pass the reason through unchanged. */
class StatsError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const statements = new Map();
const sql = (text) => {
  if (!statements.has(text)) statements.set(text, db.prepare(text));
  return statements.get(text);
};

/**
 * A player's stats, from cache when they are fresh enough.
 *
 * Every miss spends one call against a key with a monthly quota, and a
 * player's lifetime totals do not move between two people searching the same
 * name a minute apart. So the cache is about the quota first and speed second.
 */
export async function playerStats(rawName, { maxAgeMinutes = config.stats.cacheMinutes } = {}) {
  const name = String(rawName ?? '').trim();
  if (name.length < 3 || name.length > 32) {
    throw new StatsError('That is not a Fortnite display name.', 400);
  }

  const key = name.toLowerCase();
  const cached = sql(
    `SELECT * FROM player_stats
      WHERE name = ?
        AND fetched_at > datetime('now', ?)`,
  ).get(key, `-${Number(maxAgeMinutes)} minutes`);

  if (cached) return { ...JSON.parse(cached.payload), cached: true };

  const apiKey = setting(STATS_KEY);
  if (!apiKey) {
    throw new StatsError('No Fortnite API key is set. Add one in the panel.', 503);
  }

  const url = `${BASE}?name=${encodeURIComponent(name)}&accountType=epic&timeWindow=lifetime&image=none`;

  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new StatsError('Could not reach the stats service.', 502);
  }

  if (response.status === 404) throw new StatsError('No player by that name.', 404);
  if (response.status === 403) {
    // Their own wording is "account is private"; worth passing on plainly,
    // because it is the one failure the player themselves can fix.
    throw new StatsError('That account has its stats set to private.', 403);
  }
  if (response.status === 401) throw new StatsError('The Fortnite API key was rejected.', 502);
  if (response.status === 429) throw new StatsError('Too many lookups right now. Try again shortly.', 429);
  if (!response.ok) throw new StatsError('The stats service returned an error.', 502);

  const body = await response.json();
  const shaped = shape(body?.data);
  if (!shaped) throw new StatsError('The stats service sent something unexpected.', 502);

  sql(
    `INSERT INTO player_stats (name, display_name, account_id, payload, fetched_at)
     VALUES (@name, @display_name, @account_id, @payload, datetime('now'))
     ON CONFLICT(name) DO UPDATE SET display_name = excluded.display_name,
                                     account_id   = excluded.account_id,
                                     payload      = excluded.payload,
                                     fetched_at   = datetime('now')`,
  ).run({
    name: key,
    display_name: shaped.name,
    account_id: shaped.accountId,
    payload: JSON.stringify(shaped),
  });

  return { ...shaped, cached: false };
}

/**
 * Upstream's response, reduced to what a card shows.
 *
 * Sent whole, the payload is several hundred fields across four input types
 * and five party sizes. The app needs eleven numbers, and picking them here
 * means the card can be built without every client re-deriving a K/D.
 */
function shape(data) {
  const overall = data?.stats?.all?.overall;
  if (!overall || !data?.account) return null;

  const minutes = overall.minutesPlayed ?? 0;
  const matches = overall.matches ?? 0;

  return {
    accountId: data.account.id ?? null,
    name: data.account.name ?? null,
    level: data.battlePass?.level ?? null,
    levelProgress: data.battlePass?.progress ?? null,

    wins: overall.wins ?? 0,
    // Upstream sends 91.2 for 91.2%, not 0.912. Passed through as it comes,
    // and the field name says which — a client that guesses gets it wrong by
    // two orders of magnitude.
    winRatePercent: overall.winRate ?? 0,
    matches,

    kd: overall.kd ?? 0,
    killsPerMatch: overall.killsPerMatch ?? 0,
    kills: overall.kills ?? 0,
    deaths: overall.deaths ?? 0,

    minutesPlayed: minutes,
    // Averaged here rather than in the app: a zero-match account divides by
    // zero, and that is a decision to make once.
    averageMatchSeconds: matches > 0 ? Math.round((minutes * 60) / matches) : 0,

    top3: overall.top3 ?? null,
    top10: overall.top10 ?? null,
    playersOutlived: overall.playersOutlived ?? null,
    lastModified: data.stats?.all?.overall?.lastModified ?? null,
  };
}

/** What the panel reports about the cache. */
export function statsSummary() {
  return sql(
    `SELECT COUNT(*) AS players, MAX(fetched_at) AS newest FROM player_stats`,
  ).get();
}
