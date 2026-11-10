import { Router } from 'express';

import { cached } from '../cache/store.js';
import { isDbEnabled } from '../db/pool.js';
import { log } from '../log.js';
import { topMovers } from '../db/meta_repo.js';
import {
  activityDaily,
  activityTotals,
  battlesPerDay,
  brawlerTotals,
  modeShare,
  pipelineStatus,
  rankedByDivision,
  trophiesPerDay,
} from '../db/community_repo.js';
import { buildReport } from '../community/report.js';

/**
 * GET /meta/community — the week in Brawl Stars: meta board, momentum, mode
 * share, ranked tiers, trophy breakdown, weekly rhythm, and community activity
 * (unlocks, progression, clubs, icons) from src/community/diff.js counters.
 *
 * Built from a dozen aggregate queries over a week of battles, so it is cached
 * for 20 minutes and served stale if a rebuild fails.
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

export async function communityReport(now = new Date()) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = isoDay(today - 6 * DAY);
  const weekStart = new Date(today - 6 * DAY);
  const rhythmStart = new Date(today - 7 * DAY);

  const [brawlers, movers, modes, ranked, trophies, perDay, totals, daily, pipeline, icons] =
    await Promise.all([
      brawlerTotals(from),
      topMovers({ days: 7, limit: 60 }),
      modeShare(weekStart),
      rankedByDivision(weekStart),
      trophiesPerDay(new Date(today - 13 * DAY)),
      battlesPerDay(rhythmStart),
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
      modes,
      ranked,
      // The rhythm compares whole days: today is still filling up.
      battlesPerDay: perDay.filter((d) => d.day < isoDay(today)),
      trophies: trophies.filter((d) => d.day < isoDay(today)),
      activityTotals: totals,
      activityDaily: daily,
      pipeline,
      iconCatalog: icons,
    },
    now,
  );
}

communityRouter.get('/meta/community', async (req, res) => {
  if (!isDbEnabled()) {
    res.status(503).json({ error: 'community_unavailable', message: 'This deployment has no database configured.' });
    return;
  }
  try {
    const { data } = await cached('community:report:v1', 1_200, () => communityReport());
    res.set('Cache-Control', 'public, max-age=300');
    res.json(data);
  } catch (err) {
    log.error('Community report failed', { error: err.message });
    res.status(502).json({ error: 'community_failed', message: 'Community stats are unavailable right now.' });
  }
});
