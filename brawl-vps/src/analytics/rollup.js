/**
 * Keeps the daily analytics rollups current.
 *
 * Synergy, counters, draft and brackets read per-day aggregates (migration 006)
 * instead of self-joining a week of raw battles, which outran the gateway's
 * 20-second limit. This is the job that writes them.
 *
 * ## Schedule
 *
 * - Shortly after boot, backfill: every day of the last BACKFILL_DAYS that has
 *   never been rolled, or was rolled from a source the analytics no longer
 *   read. Newest first, so the short windows are covered within a minute or two
 *   of a deploy and the week fills in behind them.
 * - Every 30 minutes after that: today and yesterday again (the crawler keeps
 *   finding battles from the last day or so), one older day from the backfill
 *   range in rotation (battle logs reach back further than a day for players
 *   who play rarely, so each older day is refreshed every few hours), and any
 *   day still missing because an earlier attempt failed.
 *
 * ## Load
 *
 * Strictly one day at a time, one connection, with a pause between days. A day
 * is a single transaction that scans that day's raw rows once. Never parallel:
 * the point is to take load off the database, and eight concurrent day-scans
 * would be the week-long query again by another name.
 *
 * ## Failure
 *
 * Nothing here throws to the caller. A failed day is logged, left as it was
 * (the transaction rolls back), and picked up on the next tick.
 */

import { config } from '../config.js';
import { log } from '../log.js';
import { isDbEnabled } from '../db/pool.js';
import { resolveSource } from '../db/source.js';
import {
  addDays,
  daysBetween,
  pruneRollups,
  rolledDays,
  rollupDay,
  utcDay,
} from '../db/rollup_repo.js';

/** Days the backfill reaches back, today included — a 168h read needs 8. */
export const BACKFILL_DAYS = 8;

/** Between ticks. Also the worst-case staleness of today's numbers. */
const INTERVAL_MS = 30 * 60_000;

/** After boot, so the server is answering and the first crawl has started. */
const FIRST_RUN_DELAY_MS = 60_000;

/** Between two days of one tick, so request traffic gets the database back. */
const PAUSE_BETWEEN_DAYS_MS = 2_000;

/**
 * Rollups are kept this long. The routes clamp `hours` to 720, which reads at
 * most 31 days (window start rounded down to midnight); one more is slack.
 */
const KEEP_DAYS = 32;

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

let timer = null;
let inFlight = false;
let stopped = false;
// Which older day the next tick refreshes. Walks yesterday-1 back to the end of
// the backfill range and wraps.
let rotation = 0;

/**
 * Days a tick should roll, newest first, without duplicates.
 *
 * Exported for the test: the scheduling rules are the part most worth pinning
 * down, and they are pure once the rolled days are known.
 */
export function planTick({ today, rolled, source, rotationIndex, initial }) {
  const oldest = addDays(today, -(BACKFILL_DAYS - 1));
  const range = daysBetween(oldest, today).reverse();

  // Never rolled, or rolled from the other raw table.
  const stale = range.filter((d) => rolled.get(d) !== source);

  // Today always: after a restart it may be a deploy's downtime out of date.
  if (initial) return [...new Set([today, ...stale])];

  const older = range.slice(2);
  const rotating = older.length ? [older[rotationIndex % older.length]] : [];

  return [...new Set([today, addDays(today, -1), ...rotating, ...stale])];
}

async function tick(initial) {
  if (inFlight) {
    log.warn('Analytics rollup still running, skipping this tick');
    return;
  }
  inFlight = true;

  try {
    const today = utcDay();
    const oldest = addDays(today, -(BACKFILL_DAYS - 1));
    const rolled = await rolledDays(oldest, today);

    // The bookkeeping table is unreadable — no database right now, or
    // migration 006 did not apply. Nothing useful can happen until it is.
    if (!rolled) {
      log.warn('Analytics rollup skipped: rollup_runs is not readable');
      return;
    }

    const { name: source } = await resolveSource();
    const plan = planTick({
      today,
      rolled,
      source,
      rotationIndex: rotation,
      initial,
    });
    if (!initial) rotation += 1;

    if (initial) {
      log.info('Analytics rollup backfill starting', {
        days: plan.length,
        source,
      });
    }

    let failed = 0;
    for (const [i, day] of plan.entries()) {
      if (stopped) break;
      if (i > 0) await sleep(PAUSE_BETWEEN_DAYS_MS);

      const summary = await rollupDay(day);
      if (summary) {
        log.info('Analytics rollup day done', summary);
      } else {
        failed += 1;
        log.warn('Analytics rollup day failed, will retry next tick', { day });
      }
    }

    const pruned = await pruneRollups(KEEP_DAYS);
    if (pruned) log.info('Analytics rollups pruned', { rows: pruned, keepDays: KEEP_DAYS });

    if (initial) {
      log.info('Analytics rollup backfill finished', {
        days: plan.length,
        failed,
      });
    }
  } catch (err) {
    // rollupDay and the repo helpers already swallow database errors; this is
    // the backstop for anything else, so a bug here cannot take the API down.
    log.error('Analytics rollup tick failed', { error: err.message });
  } finally {
    inFlight = false;
  }
}

/** Starts the job. A no-op without a database or with rollups turned off. */
export function startRollups() {
  if (!isDbEnabled()) {
    log.info('Analytics rollups off: no database configured');
    return;
  }
  if (!config.analytics.rollups) {
    log.info('Analytics rollups off (ANALYTICS_ROLLUPS=false) — raw queries serve');
    return;
  }

  stopped = false;

  // A chained timeout rather than setInterval: the next tick is scheduled when
  // this one ends, so a slow backfill can never stack a second one on top.
  const schedule = (delay, initial) => {
    timer = setTimeout(async () => {
      await tick(initial);
      if (!stopped) schedule(INTERVAL_MS, false);
    }, delay);
    // Don't let the job hold the event loop open during shutdown.
    timer.unref();
  };

  schedule(FIRST_RUN_DELAY_MS, true);

  log.info('Analytics rollups scheduled', {
    intervalMinutes: INTERVAL_MS / 60_000,
    backfillDays: BACKFILL_DAYS,
  });
}

/** Stops scheduling. A day already rolling finishes or is rolled back by Postgres. */
export function stopRollups() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}
