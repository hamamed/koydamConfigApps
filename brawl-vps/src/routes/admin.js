import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express, { Router } from 'express';

import { config } from '../config.js';
import { requirePlatformAuth } from '../platform-auth.js';
import { dbHealth } from '../db/pool.js';
import {
  latestStandings,
  panelSummary,
  recentRuns,
  tableSizes,
  topMovers,
  universeStats,
} from '../db/meta_repo.js';
import {
  browsableTables,
  browseTable,
  tableCounts,
} from '../db/browse_repo.js';
import { currentSourceName } from '../db/source.js';
import { metaStats } from '../transform/brawler_meta.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = path.join(HERE, '..', 'panel');

/**
 * The live operations panel and the JSON it runs on.
 *
 * Everything here is behind the platform login at config.hamaprojects.com.
 * The panel exposes crawl internals, failure messages and sampling reach —
 * none of it secret exactly, but all of it operational detail that has no
 * business being public.
 */
export const adminRouter = Router();

/**
 * The panel is gated by the platform login, not by a key.
 *
 * ADMIN_KEY put a secret in the query string, which lands in browser history,
 * bookmarks, nginx access logs and every screenshot of this page — and it was
 * all-or-nothing, so there was no way to give someone Brawl without giving
 * them everything. Access is now a role on an account at
 * config.hamaprojects.com, checked per request.
 */
const requireAdmin = requirePlatformAuth();

/**
 * The panel's script.
 *
 * Registered *before* the /admin guard and on a path outside it, because a
 * `<script src>` request carries no query string and no custom header — it
 * would 401 and the page would render empty, which is exactly the failure this
 * file exists to avoid. Nothing here is secret: it is rendering code, and the
 * admin key lives in the page URL, not in the script.
 */
adminRouter.get('/panel.js', (_req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(PANEL_DIR, 'panel.js'));
});

/**
 * The panel's stylesheet, and Bootstrap under it.
 *
 * Vendored from node_modules rather than pulled from a CDN. The panel is served
 * with `script-src 'self'` and a matching style policy — a CDN would be blocked
 * outright, which is precisely how this page rendered blank the first time. It
 * also means the panel works on a box with no outbound internet.
 *
 * Same reasoning as /panel.js for sitting outside the /admin guard: a
 * `<link rel=stylesheet>` carries no query string, so behind the guard it would
 * 401 and the page would render unstyled.
 */
// The shared design system, copied from koydam-agency so every panel on this
// box looks like one product. A directory rather than a single file because it
// is two stylesheets — tokens, then the dashboard shell.
adminRouter.use(
  '/panel/css',
  express.static(path.join(PANEL_DIR, 'css'), { maxAge: '1h', fallthrough: false }),
);

adminRouter.get('/panel-vendor.css', (_req, res) => {
  res.type('text/css');
  res.sendFile(
    path.join(HERE, '..', '..', 'node_modules', 'bootstrap', 'dist', 'css', 'bootstrap.min.css'),
  );
});

/**
 * Lucide icons, as one inline SVG sprite.
 *
 * A sprite rather than 20 separate requests, and inline `<symbol>`s rather than
 * the Lucide runtime — that runtime rewrites the DOM from a script, which the
 * CSP would allow but which adds a dependency for something that is, in the
 * end, static path data.
 *
 * Built once at first request and held: the files never change between
 * restarts, and re-reading twenty of them per page load is pure waste.
 */
let spriteCache = null;

adminRouter.get('/panel-icons.svg', async (_req, res) => {
  if (!spriteCache) spriteCache = await buildSprite();
  res.type('image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(spriteCache);
});

/** Icons the panel actually uses. Anything not listed is never shipped. */
const ICONS = [
  'database', 'activity', 'users', 'swords', 'hard-drive', 'clock',
  'trending-up', 'trending-down', 'circle-check', 'circle-alert', 'table',
  'refresh-cw', 'map', 'gauge', 'layers', 'search', 'server', 'list',
  'chart-column', 'trophy',
];

async function buildSprite() {
  const dir = path.join(HERE, '..', '..', 'node_modules', 'lucide-static', 'icons');
  const symbols = [];

  for (const name of ICONS) {
    try {
      const svg = await readFile(path.join(dir, `${name}.svg`), 'utf8');
      // Keep the drawing, drop the wrapper: a <symbol> supplies its own
      // viewBox and inherits stroke colour from the page.
      const inner = svg.replace(/<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
      symbols.push(
        `<symbol id="i-${name}" viewBox="0 0 24 24" fill="none" ` +
          `stroke="currentColor" stroke-width="2" stroke-linecap="round" ` +
          `stroke-linejoin="round">${inner}</symbol>`,
      );
    } catch {
      // A renamed icon should cost one missing glyph, not the whole sprite.
      continue;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">${symbols.join('')}</svg>`;
}

adminRouter.use('/admin', requireAdmin);

/** The panel itself — a single static page, no build step. */
adminRouter.get('/admin', (_req, res) => {
  res.sendFile(path.join(PANEL_DIR, 'index.html'));
});

/**
 * Everything the panel renders, in one response.
 *
 * One endpoint rather than five: the page polls, and five polling requests
 * would multiply both the round trips and the chances of showing a half-updated
 * dashboard where the counters and the run list disagree.
 */
adminRouter.get('/admin/data', async (_req, res) => {
  const [db, summary, runs, standings, movers, sizes, universe, counts] =
    await Promise.all([
      dbHealth(),
      panelSummary(),
      recentRuns(15),
      latestStandings(25),
      topMovers({ days: 7, limit: 8 }),
      tableSizes(),
      universeStats(),
      tableCounts(),
    ]);

  res.json({
    now: new Date().toISOString(),
    db,
    crawler: {
      enabled: config.crawler.enabled,
      intervalMinutes: config.crawler.intervalMinutes,
      playersPerRegion: config.crawler.playersPerRegion,
      regions: config.crawler.regions,
      minSampleSize: config.crawler.minSampleSize,
    },
    brawlerMeta: metaStats(),
    // Which record the meta screens are being served from. The switchover is
    // automatic, so without this there is no way to tell whether it happened.
    analyticsSource: currentSourceName(),
    summary,
    runs: runs ?? [],
    standings: standings ?? [],
    movers: movers ?? [],
    sizes: sizes ?? [],
    universe,
    tables: browsableTables(),
    counts,
    discovery: {
      perCycle: config.crawler.discoveryPerCycle,
      searchedPerCycle: config.crawler.searchedPerCycle,
      profilesPerCycle: config.crawler.profilesPerCycle,
      retentionDays: config.postgres.retentionDays,
      battleRetentionDays: config.postgres.battleRetentionDays,
    },
  });
});

/**
 * The newest rows of one table.
 *
 * Separate from /admin/data because it is the only part the operator drives:
 * the dashboard polls on a timer, while this fires when someone picks a table.
 * Folding it into the poll would re-fetch fifty rows every few seconds for a
 * panel nobody is looking at.
 */
adminRouter.get('/admin/table/:name', async (req, res) => {
  const result = await browseTable(req.params.name, req.query.limit);

  // The name is matched against a whitelist, never interpolated from the
  // request — an unknown one is a 404 rather than a query.
  if (!result) {
    return res.status(404).json({
      error: 'unknown_table',
      message: 'Not a browsable table.',
    });
  }

  res.json(result);
});
