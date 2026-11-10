import { Router } from 'express';

import { cached, cacheGet, cacheSet } from '../cache/store.js';
import { isDbEnabled } from '../db/pool.js';
import { log } from '../log.js';
import { topMovers } from '../db/meta_repo.js';
import {
  activityDaily,
  activityTotals,
  battleCount,
  brawlerTotals,
  modeShare,
  pipelineStatus,
  rankedByDivision,
  trophyTotals,
} from '../db/community_repo.js';
import { buildReport } from '../community/report.js';

/**
 * GET /meta/community — the week in Brawl Stars: meta board, momentum, mode
 * share, ranked tiers, trophy breakdown, weekly rhythm, and community activity
 * (unlocks, progression, clubs, icons) from src/community/diff.js counters.
 *
 * Built in the background (every 15 minutes, first a few minutes after boot so
 * it does not race the rollup backfill) and served from cache. The raw-battle
 * queries run per UTC day and finished days are cached for a week, so a
 * rebuild scans only today. A request that finds no report yet waits briefly
 * for a build in progress, then answers 503 "building" with Retry-After.
 */
export const communityRouter = Router();

const DAY = 86_400_000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const ICONS_URL = 'https://api.brawlapi.com/v1/icons';

/** Public icon catalog (id → entry), for icon categories. Empty when unreachable. */
async function iconCatalog() {
  try {
    const { data } = await cached('community:icons', 86_400, async () => {
      const res = await fetch(ICONS_URL, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`icons ${res.status}`);
      const body = await res.json();
      const out = {};
      for (const e of Object.values(body?.player ?? {})) {
        out[e.id] = { name: e.name, name2: e.name2, brawler: e.brawler ?? null, isAvailableForOffers: Boolean(e.isAvailableForOffers) };
      }
      return out;
    });
    return data ?? {};
  } catch (err) {
    log.warn('Icon catalog unavailable; icon categories fall back to "other"', { error: err.message });
    return {};
  }
}

/**
 * One query per UTC day over `days`, run one after another. Days at least two
 * days old are cached for a week; today and yesterday are always re-read,
 * since battle logs fetched hours later still add battles to them.
 * Returns `[{ day, value }]` in day order.
 */
async function perDay(name, days, todayIso, fn) {
  const settled = isoDay(Date.parse(`${todayIso}T00:00:00Z`) - DAY);
  const out = [];
  for (const day of days) {
    const start = new Date(`${day}T00:00:00Z`);
    const end = new Date(start.getTime() + DAY);
    const key = `community:day:${name}:${day}`;
    const cacheable = day < settled;
    const hit = cacheable ? await cacheGet(key) : null;
    if (hit !== null) {
      out.push({ day, value: hit });
      continue;
    }
    const value = await fn(start, end);
    if (cacheable) await cacheSet(key, value, 8 * 86_400);
    out.push({ day, value });
  }
  return out;
}

const daysBack = (today, n) => Array.from({ length: n }, (_, i) => isoDay(today - (n - 1 - i) * DAY));

/** Sums per-day row lists by `keyOf`, adding the numeric fields in `fields`. */
function merge(perDayRows, keyOf, fields) {
  const out = new Map();
  for (const { value } of perDayRows) {
    for (const row of value) {
      const key = keyOf(row);
      const acc = out.get(key) ?? { ...row, ...Object.fromEntries(fields.map((f) => [f, 0])) };
      for (const f of fields) acc[f] += row[f];
      out.set(key, acc);
    }
  }
  return [...out.values()];
}

export async function communityReport(now = new Date()) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const todayIso = isoDay(today);
  const week = daysBack(today, 7);
  const from = week[0];

  // Sequential, not parallel: these are the heavy scans, and running them one
  // at a time keeps the database responsive for live traffic.
  const modeDays = await perDay('modes', week, todayIso, modeShare);
  const rankedDays = await perDay('ranked', week, todayIso, rankedByDivision);
  const trophyDays = await perDay('trophies', daysBack(today - DAY, 14), todayIso, trophyTotals);
  const countDays = await perDay('battles', daysBack(today - DAY, 7), todayIso, battleCount);

  const [brawlers, movers, totals, daily, pipeline, icons] = await Promise.all([
    brawlerTotals(from),
    topMovers({ days: 7, limit: 60 }),
    activityTotals(from),
    activityDaily(from),
    pipelineStatus(),
    iconCatalog(),
  ]);

  return buildReport(
    {
      from,
      brawlers,
      movers,
      modes: merge(modeDays, (r) => r.mode, ['battles']).sort((a, b) => b.battles - a.battles),
      ranked: merge(rankedDays, (r) => `${r.division}:${r.id}`, ['picks', 'decided', 'wins', 'battles']),
      // Whole days only: today is still filling up.
      battlesPerDay: countDays.map(({ day, value }) => ({ day, battles: value })),
      trophies: trophyDays.map(({ day, value }) => ({ day, ...value })),
      activityTotals: totals,
      activityDaily: daily,
      pipeline,
      iconCatalog: icons,
    },
    now,
  );
}

const REPORT_KEY = 'community:report:v1';
const REFRESH_MS = 15 * 60_000;
let building = null;

/** Builds and stores the report; concurrent callers share one build. */
export function rebuildCommunityReport() {
  building ??= (async () => {
    const began = Date.now();
    try {
      const report = await communityReport();
      // Kept well past the refresh interval so a failed rebuild leaves the
      // last good report in place rather than a gap.
      await cacheSet(REPORT_KEY, report, 6 * 3_600);
      log.info('Community report built', { ms: Date.now() - began });
      return report;
    } catch (err) {
      log.error('Community report failed', { error: err.message });
      return null;
    } finally {
      building = null;
    }
  })();
  return building;
}

let timer = null;

/** Background refresh. First build after `delayMs`, then every 15 minutes. */
export function startCommunityReports(delayMs = 6 * 60_000) {
  if (timer || !isDbEnabled()) return;
  timer = setTimeout(function tick() {
    rebuildCommunityReport().finally(() => {
      timer = setTimeout(tick, REFRESH_MS);
      timer.unref?.();
    });
  }, delayMs);
  timer.unref?.();
}

export function stopCommunityReports() {
  clearTimeout(timer);
  timer = null;
}

const WAIT_MS = 12_000;

communityRouter.get('/meta/community', async (req, res) => {
  if (!isDbEnabled()) {
    res.status(503).json({ error: 'community_unavailable', message: 'This deployment has no database configured.' });
    return;
  }
  let report = await cacheGet(REPORT_KEY);
  if (report === null) {
    const build = rebuildCommunityReport();
    report = await Promise.race([build, new Promise((r) => setTimeout(() => r(null), WAIT_MS).unref?.())]);
  }
  if (!report) {
    res.set('Retry-After', '60');
    res.status(503).json({ error: 'building', message: 'Community stats are being built. Try again in a minute.' });
    return;
  }
  res.set('Cache-Control', 'public, max-age=300');
  res.json(report);
});
