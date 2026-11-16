import { Router } from 'express';

import { isDbEnabled, query } from '../db/pool.js';
import { log } from '../log.js';
import { cachedOrBuilding, cachedShared, daysBack, isoDay, merge, perDay, utcMidnight, DAY } from '../community/perday.js';
import { rankedByDivision } from '../db/community_repo.js';
import {
  allBrawlerTotals,
  brawlerCounters,
  brawlerDaily,
  brawlerMaps,
  brawlerModes,
  mapActivity,
  mapBrawlers,
  mapRanked,
  mapRotations,
  mapSummary,
  mapTeams,
  modeBrawlers,
  modeDaily,
  modeMaps,
  modeRanked,
  modeSummary,
  rangeTotals,
} from '../db/profile_repo.js';
import { brawlerProfile, mapProfile, modeProfile } from '../community/profiles.js';

/**
 * Brawler, map and mode pages:
 *   GET /meta/brawler/:id/profile        win rate by range, ranked, modes, maps, trend, build
 *   GET /meta/maps/profile?map=&range=   map meta, snapshot, teams, pairs, rotation
 *   GET /meta/mode/:mode/profile         mode meta, ranked, maps, battles, length
 *   GET /meta/maps/activity              battles per map, last day and week
 *
 * Each is cached for 20 minutes, with the last good copy kept for three days:
 * once a page has been built it answers at once, and an expired copy is
 * rebuilt behind the answer. `warmProfiles` (run with the community report)
 * keeps every brawler and mode page built, so users never wait on the
 * database. A page that was never built waits up to 14 s for its build, then
 * gets 503 "building" (with Retry-After) while the build finishes.
 */
export const profilesRouter = Router();

const TTL = 1_200;
const RANGES = new Set(['all', '0-499', '500-999', '1000+']);
const MODE_RE = /^[a-zA-Z0-9]{2,40}$/;

function unavailable(res) {
  res.status(503).json({ error: 'profiles_unavailable', message: 'This deployment has no database configured.' });
}

function building(res) {
  res.set('Retry-After', '30');
  res.status(503).json({ error: 'building', message: 'These stats are being built. Try again in a few seconds.' });
}

async function serve(res, key, build) {
  if (!isDbEnabled()) return unavailable(res);
  try {
    const data = await cachedOrBuilding(key, TTL, build);
    if (!data) return building(res);
    res.set('Cache-Control', 'public, max-age=300');
    res.json(data);
  } catch (err) {
    log.error('Profile build failed', { key, error: err.message });
    res.status(502).json({ error: 'profile_failed', message: 'These stats are unavailable right now.' });
  }
}

/** Week window shared by the per-day caches (also warmed by the community report). */
function week(now = new Date()) {
  const today = utcMidnight(now);
  return { today, todayIso: isoDay(today), days: daysBack(today, 7), from: isoDay(today - 6 * DAY) };
}

/** Every brawler's ladder results per trophy range this week (per-day cached). */
export async function weeklyRanges() {
  const w = week();
  return merge(await perDay('ranges', w.days, w.todayIso, rangeTotals), (r) => `${r.range}:${r.id}`, ['decided', 'wins', 'picks']);
}

/**
 * The week-wide inputs every brawler page reads: all brawlers' totals, results
 * per trophy range and ranked results per division. Built once and shared, so
 * a hundred brawler pages cost one set of raw-battle scans, not a hundred.
 */
const WEEK_INPUTS_TTL = 900;
function weekInputs(w = week()) {
  return cachedShared(`profile:week-inputs:v1:${w.todayIso}`, WEEK_INPUTS_TTL, async () => {
    const totals = await allBrawlerTotals(w.from);
    const ranges = await weeklyRanges();
    const ranked = merge(await perDay('ranked', w.days, w.todayIso, rankedByDivision), (r) => `${r.division}:${r.id}`, ['picks', 'decided', 'wins', 'battles']);
    return { totals, ranges, ranked };
  });
}

const brawlerProfileKey = (id) => `profile:brawler:v1:${id}`;

async function buildBrawlerProfile(id) {
  const w = week();
  const { totals, ranges, ranked } = await weekInputs(w);
  const [modes, maps, daily, counters] = await Promise.all([
    brawlerModes(id, w.from), brawlerMaps(id, w.from), brawlerDaily(id, w.from), brawlerCounters(id, w.from),
  ]);
  return brawlerProfile({ id, totals, ranges, ranked, modes, maps, daily, counters });
}

profilesRouter.get('/meta/brawler/:id/profile', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 16_000_000 || id > 16_999_999) {
    res.status(400).json({ error: 'bad_request', message: 'Invalid brawler id.' });
    return;
  }
  return serve(res, brawlerProfileKey(id), () => buildBrawlerProfile(id));
});

profilesRouter.get('/meta/maps/profile', (req, res) => {
  const map = typeof req.query.map === 'string' ? req.query.map.trim() : '';
  const range = typeof req.query.range === 'string' ? req.query.range : 'all';
  if (!map || map.length > 80 || !RANGES.has(range)) {
    res.status(400).json({ error: 'bad_request', message: 'Give a map name and a range of all, 0-499, 500-999 or 1000+.' });
    return;
  }
  return serve(res, mapProfileKey(map, range), () => buildMapProfile(map, range));
});

export const mapProfileKey = (map, range) => `profile:map:v1:${map.toLowerCase()}:${range}`;

/** One map's page (also used per live event by /events/overview). */
export async function buildMapProfile(map, range = 'all') {
  const now = new Date();
  const since = new Date(now.getTime() - 30 * DAY);
  const [rows, ranked, teams, summary, rotations] = await Promise.all([
    mapBrawlers(map, since), mapRanked(map, since), mapTeams(map, since), mapSummary(map, since), mapRotations(map),
  ]);
  const modeRows = summary.mode ? await modeBrawlers(summary.mode, week(now).from) : [];
  return mapProfile({ map, range, rows, ranked, teams, summary, rotations, modeRows, now });
}

const normalise = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
let modeIndex = { at: 0, map: new Map() };

/** The stored spelling of a mode ("brawlBall") from any casing ("brawlball", "Brawl Ball"). */
async function resolveMode(raw) {
  if (Date.now() - modeIndex.at > 3_600_000) {
    const rows = await query(`SELECT DISTINCT mode FROM brawler_stats_daily WHERE day >= current_date - 30`);
    modeIndex = { at: Date.now(), map: new Map((rows?.rows ?? []).map((r) => [normalise(r.mode), r.mode])) };
  }
  return modeIndex.map.get(normalise(raw)) ?? raw;
}

const modeProfileKey = (mode) => `profile:mode:v1:${mode}`;

async function buildModeProfile(mode) {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * DAY);
  const [board, ranked, maps, summary, daily] = await Promise.all([
    modeBrawlers(mode, week(now).from),
    modeRanked(mode, weekAgo),
    modeMaps(mode, new Date(now.getTime() - 30 * DAY)),
    modeSummary(mode, weekAgo),
    modeDaily(mode, weekAgo),
  ]);
  return modeProfile({ mode, board, ranked, maps, summary, daily });
}

profilesRouter.get('/meta/mode/:mode/profile', async (req, res) => {
  if (!MODE_RE.test(req.params.mode)) {
    res.status(400).json({ error: 'bad_request', message: 'Invalid mode.' });
    return;
  }
  const mode = isDbEnabled() ? await resolveMode(req.params.mode).catch(() => req.params.mode) : req.params.mode;
  return serve(res, modeProfileKey(mode), () => buildModeProfile(mode));
});

async function buildMapActivity() {
  const now = Date.now();
  const rows = await mapActivity(new Date(now - DAY), new Date(now - 7 * DAY));
  return { maps: rows.sort((a, b) => b.day - a.day || b.week - a.week) };
}

profilesRouter.get('/meta/maps/activity', (req, res) => serve(res, 'profile:maps:activity:v1', buildMapActivity));

/**
 * Builds every brawler page and every mode played this week, one after
 * another, wherever the fresh copy has run out. Run in the background after
 * each community report, so a user opening any of them gets a cached answer.
 */
export async function warmProfiles() {
  if (!isDbEnabled()) return;
  const began = Date.now();
  let brawlers = 0;
  let modes = 0;
  try {
    const { totals } = await weekInputs();
    for (const { id } of totals) {
      if (!Number.isInteger(id) || id < 16_000_000 || id > 16_999_999) continue;
      await cachedShared(brawlerProfileKey(id), TTL, () => buildBrawlerProfile(id));
      brawlers += 1;
    }
    await resolveMode('');
    for (const mode of modeIndex.map.values()) {
      if (!MODE_RE.test(mode)) continue;
      await cachedShared(modeProfileKey(mode), TTL, () => buildModeProfile(mode));
      modes += 1;
    }
    await cachedShared('profile:maps:activity:v1', TTL, buildMapActivity);
    log.info('Profiles warmed', { ms: Date.now() - began, brawlers, modes });
  } catch (err) {
    log.warn('Profile warm-up stopped', { ms: Date.now() - began, brawlers, modes, error: err.message });
  }
}
