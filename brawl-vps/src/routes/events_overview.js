import { Router } from 'express';

import { cacheGet, cacheSet } from '../cache/store.js';
import { isDbEnabled } from '../db/pool.js';
import { log } from '../log.js';
import { supercell } from '../supercell/client.js';
import { daysBack, isoDay, merge, perDay, utcMidnight, DAY } from '../community/perday.js';
import { predictedMaps, rankedMaps, trophyBands } from '../db/profile_repo.js';
import { eventStats, rankedPool, trophyBreakdown } from '../community/events.js';
import { buildMapProfile, mapProfileKey } from './profiles.js';

/**
 * GET /events/overview — the Events tab, Brawlify-style: every live event with
 * its map's best picks, most used, top teams, battles and length; predicted
 * next maps per slot; a trophy-band breakdown; the ranked map pool by tier.
 * Rebuilt in the background with the community report; served from cache.
 */
export const eventsOverviewRouter = Router();

const KEY = 'events:overview:v1';

/** "20261110T080000.000Z" → Date. */
function eventTime(raw) {
  if (typeof raw !== 'string' || raw.length < 15) return null;
  const ms = Date.parse(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 11)}:${raw.slice(11, 13)}:${raw.slice(13)}`);
  return Number.isNaN(ms) ? null : new Date(ms);
}

export async function buildEventsOverview(now = new Date()) {
  const raw = await supercell.events();
  const live = (Array.isArray(raw) ? raw : raw?.items ?? []).filter((e) => e?.event?.map);
  const events = [];
  for (const e of live) {
    const map = e.event.map;
    const mode = e.event.mode ?? 'unknown';
    const start = eventTime(e.startTime);
    const end = eventTime(e.endTime);
    const windowSeconds = start && end ? (end - start) / 1000 : 86_400;
    // The map page's cache is shared, so an event build warms the map pages too.
    let profile = await cacheGet(mapProfileKey(map, 'all'));
    if (profile === null) {
      profile = await buildMapProfile(map, 'all');
      await cacheSet(mapProfileKey(map, 'all'), profile, 1_200);
    }
    const next = await predictedMaps(mode, Number(e.slotId ?? 0), map, windowSeconds);
    events.push({
      slotId: Number(e.slotId ?? 0),
      mode,
      map,
      start: start?.toISOString() ?? null,
      end: end?.toISOString() ?? null,
      stats: eventStats(profile),
      upNext: next.map((n, i) => ({ map: n.map, estStart: end ? new Date(end.getTime() + i * windowSeconds * 1000).toISOString() : null })),
    });
  }
  const today = utcMidnight(now);
  const days = daysBack(today, 7);
  const ranked = merge(await perDay('rankedmaps', days, isoDay(today), rankedMaps), (r) => `${r.map}|${r.tier}|${r.id}`, ['picks', 'decided', 'wins', 'battles']);
  return {
    generatedAt: now.toISOString(),
    events: events.sort((a, b) => (a.end ?? '').localeCompare(b.end ?? '')),
    trophies: trophyBreakdown(await trophyBands(new Date(now.getTime() - DAY))),
    ranked: rankedPool(ranked),
  };
}

let building = null;
/** Builds and stores the overview; concurrent callers share one build. */
export function rebuildEventsOverview() {
  building ??= (async () => {
    const began = Date.now();
    try {
      const data = await buildEventsOverview();
      await cacheSet(KEY, data, 3 * 3_600);
      log.info('Events overview built', { ms: Date.now() - began, events: data.events.length });
      return data;
    } catch (err) {
      log.error('Events overview failed', { error: err.message });
      return null;
    } finally {
      building = null;
    }
  })();
  return building;
}

eventsOverviewRouter.get('/events/overview', async (req, res) => {
  if (!isDbEnabled()) {
    res.status(503).json({ error: 'unavailable', message: 'This deployment has no database configured.' });
    return;
  }
  let data = await cacheGet(KEY);
  if (data === null) data = await Promise.race([rebuildEventsOverview(), new Promise((r) => setTimeout(() => r(null), 14_000).unref?.())]);
  if (!data) {
    res.set('Retry-After', '30');
    res.status(503).json({ error: 'building', message: 'Event stats are being built. Try again shortly.' });
    return;
  }
  res.set('Cache-Control', 'public, max-age=120');
  res.json(data);
});

