import { cacheGet, cacheSet } from '../cache/store.js';
import { log } from '../log.js';

/**
 * Keeps a rolling window of past crawls so the tier list can show movement.
 *
 * The value here is entirely in the accumulation: no API exposes historical
 * meta, so "Ruffs climbed 3 tiers this week" is only answerable by a service
 * that has been recording. Each crawl appends a compact snapshot — brawler id,
 * tier, rank and score per mode — and the newest crawl is diffed against the
 * previous one to produce per-entry deltas.
 *
 * Snapshots are deliberately lossy: full crawl output is ~220KB, and 28 of
 * those would dominate the cache for data nobody reads in full. Storing only
 * what a delta needs keeps a fortnight of history under ~200KB total.
 */

const HISTORY_KEY = 'meta:history';

/** Roughly two weeks at hourly crawls, capped by size rather than time. */
const MAX_SNAPSHOTS = 336;

/** Strips a crawl payload down to what a diff actually needs. */
function compact(payload) {
  const modes = {};

  for (const [key, bucket] of Object.entries(payload.modes ?? {})) {
    modes[key] = {};
    for (const entry of bucket.brawlers ?? []) {
      // Array rather than object: 3 numbers instead of 3 keys per brawler,
      // which roughly halves the stored size across 300+ entries.
      modes[key][entry.id] = [entry.rank, entry.tier, round(entry.winRate)];
    }
  }

  return { at: payload.generatedAt, modes };
}

const round = (v) =>
  typeof v === 'number' ? Math.round(v * 1000) / 1000 : null;

/**
 * Appends a snapshot and returns the previous one.
 *
 * TTL is long but finite — if crawling stops, history should eventually expire
 * rather than serve deltas against a month-old baseline forever.
 */
export async function recordSnapshot(payload) {
  const history = (await cacheGet(HISTORY_KEY)) ?? [];
  const previous = history.length > 0 ? history[history.length - 1] : null;

  history.push(compact(payload));
  while (history.length > MAX_SNAPSHOTS) history.shift();

  await cacheSet(HISTORY_KEY, history, 30 * 24 * 3600);

  log.info('Meta snapshot recorded', {
    snapshots: history.length,
    modes: Object.keys(payload.modes ?? {}).length,
  });

  return previous;
}

/**
 * Annotates a fresh crawl with movement since [previous].
 *
 * Mutates in place — the payload is about to be cached anyway, and copying a
 * 220KB structure to add three fields per row would be wasteful.
 *
 * A brawler absent from the previous snapshot gets `isNew: true` rather than a
 * fabricated delta of zero: it may be genuinely new, or it may have been below
 * the sample threshold last time. Either way "no comparison available" is the
 * honest answer.
 */
export function annotateDeltas(payload, previous) {
  if (!previous) return payload;

  for (const [key, bucket] of Object.entries(payload.modes ?? {})) {
    const before = previous.modes?.[key];
    if (!before) continue;

    for (const entry of bucket.brawlers ?? []) {
      const prior = before[entry.id];
      if (!prior) {
        entry.isNew = true;
        continue;
      }

      const [prevRank, prevTier, prevWinRate] = prior;

      // Positive means improved. Rank 5 -> 2 is +3, which reads the way people
      // expect even though the number went down.
      entry.rankDelta = prevRank - entry.rank;
      entry.tierDelta = tierValue(prevTier) - tierValue(entry.tier);
      entry.winRateDelta =
        entry.winRate != null && prevWinRate != null
          ? round(entry.winRate - prevWinRate)
          : null;
      entry.previousTier = prevTier;
    }
  }

  payload.comparedTo = previous.at;
  return payload;
}

/** S is strongest, so it gets the lowest value — deltas stay "higher is better". */
function tierValue(tier) {
  return { S: 0, A: 1, B: 2, C: 3, D: 4 }[tier] ?? 4;
}

/**
 * Movement for one brawler across the stored window.
 *
 * Used by `/meta/history/:brawlerId` to draw a sparkline of tier over time.
 */
export async function brawlerHistory(brawlerId, modeKey) {
  const history = (await cacheGet(HISTORY_KEY)) ?? [];
  const id = String(brawlerId);

  return history
    .map((snap) => {
      const row = snap.modes?.[modeKey]?.[id];
      if (!row) return null;
      const [rank, tier, winRate] = row;
      return { at: snap.at, rank, tier, winRate };
    })
    .filter(Boolean);
}

export async function historyStats() {
  const history = (await cacheGet(HISTORY_KEY)) ?? [];
  return {
    snapshots: history.length,
    oldest: history[0]?.at ?? null,
    newest: history[history.length - 1]?.at ?? null,
  };
}
