import compression from 'compression';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

import { config } from './config.js';
import { remoteStatus, startRemoteSettings } from './remote-settings.js';
import { log } from './log.js';
import { cacheStats, closeCache } from './cache/store.js';
import { playerRouter } from './routes/player.js';
import { catalogRouter } from './routes/catalog.js';
import { rankingsRouter } from './routes/rankings.js';
import { clubActivityRouter } from './routes/club_activity.js';
import { metaHistoryRouter } from './routes/meta_history.js';
import { analyticsRouter } from './routes/analytics.js';
import { wallpapersRouter, WALLPAPER_ROOT } from './routes/wallpapers.js';
import { legalRouter } from './routes/legal.js';
import { adminRouter } from './routes/admin.js';
import { runMigrations } from './db/migrate.js';
import { closePool, dbHealth } from './db/pool.js';
import { reapStaleRuns } from './db/meta_repo.js';
import {
  errorHandler,
  notFoundHandler,
  requireApiKey,
} from './middleware/errors.js';
import {
  loadBrawlerMeta,
  metaStats,
  syncBrawlerMeta,
  metaIsStale,
} from './transform/brawler_meta.js';
import { runCrawl } from './crawler/meta_crawler.js';

const app = express();

/**
 * Needed for correct client IPs behind nginx — without it, express-rate-limit
 * sees every request as coming from 127.0.0.1 and rate-limits all users as one.
 * `1` = trust exactly one proxy hop.
 */
app.set('trust proxy', 1);

app.disable('x-powered-by');
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        // The admin panel shares its typeface with the rest of the Koydam
        // design system. Two hostnames, narrowly scoped — the alternative is
        // vendoring four font files to avoid one origin.
        // No 'unsafe-inline'. The panel's markup carries no style attributes,
        // so the exemption bought nothing and applied to every element on the
        // page. Matches the dashboard's policy.
        'style-src': ["'self'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        // Dropped: helmet sets this by default, and on a plain-HTTP deployment
        // it makes the browser rewrite every request to https:// — which then
        // fails, because there is no certificate. It is a hardening nicety for
        // sites that already have TLS, and actively breaks ones that do not.
        // Put it back if you terminate TLS in front of this.
        'upgrade-insecure-requests': null,
      },
    },
  }),
);
app.use(compression());

// A JSON API consumed by a mobile app: no browser origin to restrict, and
// locking this down wouldn't add security since native clients don't enforce CORS.
app.use(cors({ origin: '*', methods: ['GET'] }));

app.use(
  rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    // Health checks must never be throttled or the load balancer will see the
    // service as down under load.
    //
    // Wallpaper *files* are exempt for a different reason: a gallery screen
    // fires one request per visible tile, so opening it spends dozens of the
    // budget in a second and every image after that comes back 429 — which the
    // app renders as a broken-image icon on every tile. This limit exists to
    // protect the upstream Supercell token, and static bytes on our own disk
    // never touch it.
    //
    // The JSON index at /v1/wallpapers is still limited: that one is an API
    // call, and one per screen open rather than one per image.
    skip: (req) =>
      req.path === '/health' || req.path.startsWith('/wallpapers/'),
    message: {
      error: 'rate_limited',
      message: 'Too many requests. Try again shortly.',
    },
  }),
);

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    log.debug('request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - start,
      cache: res.get('X-Cache') ?? '-',
    });
  });
  next();
});

/**
 * Unauthenticated liveness probe. Reports subsystem state so a 200 actually
 * means "can serve traffic" rather than "process is alive".
 */
app.get('/health', async (req, res) => {
  res.json({
    status: 'ok',
    env: config.env,
    uptimeSeconds: Math.round(process.uptime()),
    cache: cacheStats(),
    db: await dbHealth(),
    settings: remoteStatus(),
    adminPanel: {
      auth: 'platform-sso',
      ssoConfigured: Boolean(process.env.PLATFORM_URL && process.env.SERVICE_TOKEN),
      // Flagged so a leftover gets removed. Nothing authenticates against it.
      staleAdminKey: config.adminKey ? true : undefined,
    },
    brawlerMeta: metaStats(),
    version: process.env.npm_package_version ?? '1.0.0',
  });
});

// Mounted before the API-key gate: the panel has its own, stronger auth, and
// requiring both would mean pasting two secrets into a browser URL.
app.use(adminRouter);

// Public and ahead of the API-key gate: App Store Connect requires a privacy
// policy at a URL a reviewer can open in a browser, and a page that demands a
// secret is not a published policy.
app.use(legalRouter);

// Wallpaper *files*, public and ahead of the API-key gate.
//
// The client loads these through an ordinary image widget, which sends no
// custom headers — gating them would mean every tile 401ing. They are static
// artwork with nothing to protect, so serving them openly is the honest trade;
// the index that describes them still sits behind the gate below.
//
// `express.static` resolves and confines every request to this root, so a
// `../` in the path cannot escape it.
app.use(
  '/wallpapers',
  express.static(WALLPAPER_ROOT, {
    // Long: a wallpaper's bytes never change. A replaced image gets a new name
    // in practice, and the index carries mtime for anything that doesn't.
    maxAge: '7d',
    immutable: false,
    // No directory listings, and no falling through to the SPA-ish handlers
    // below when a file is simply missing.
    index: false,
    fallthrough: false,
    dotfiles: 'ignore',
  }),
);

// A missing image is a 404, not a server fault.
//
// `fallthrough: false` is what stops a bad image path drifting down into the
// API routers and coming back as an auth error, but it reports the miss as a
// raw ENOENT — which the generic handler below turns into a 500 and logs at
// ERROR. A stale URL in someone's cache would fill the log with false alarms.
app.use('/wallpapers', (err, _req, res, next) => {
  if (err?.code === 'ENOENT' || err?.statusCode === 404) {
    return res.status(404).json({
      error: 'wallpaper_not_found',
      message: 'No such wallpaper. The index at /v1/wallpapers lists what exists.',
    });
  }
  return next(err);
});

app.use(requireApiKey);

// The Flutter client's ApiConfig.baseUrl points at this prefix.
app.use('/v1', playerRouter);
app.use('/v1', catalogRouter);
app.use('/v1', rankingsRouter);
app.use('/v1', clubActivityRouter);
app.use('/v1', metaHistoryRouter);
app.use('/v1', analyticsRouter);
app.use('/v1', wallpapersRouter);

// Unprefixed aliases, so a misconfigured base URL still works instead of 404ing.
app.use('/', playerRouter);
app.use('/', catalogRouter);
app.use('/', rankingsRouter);
app.use('/', clubActivityRouter);
app.use('/', metaHistoryRouter);
app.use('/', analyticsRouter);
app.use('/', wallpapersRouter);

app.use(notFoundHandler);
app.use(errorHandler);

// ── Boot ────────────────────────────────────────────────────────────────────

let crawlTimer = null;

async function boot() {
  // Before anything reads config: the panel may hold the Supercell token, and
  // a crawl starting on a stale one would fail every request in its first
  // cycle. Never fatal - if the panel is unreachable the .env values stand.
  await startRemoteSettings('brawl', log);

  // Before anything that might write: a crawl firing against an unmigrated
  // database would fail every insert.
  await runMigrations();

  // Any row still marked running belongs to a process that is no longer here —
  // this service runs one crawl at a time, and it has just started.
  await reapStaleRuns();

  const count = await loadBrawlerMeta();

  // Sync on first boot or when the on-disk copy has aged out. Non-fatal: the
  // API still serves player data without it, just missing rarity and portraits.
  if (count === 0 || metaIsStale()) {
    try {
      await syncBrawlerMeta();
    } catch (err) {
      log.warn('Brawler metadata sync failed — continuing without it', {
        error: err.message,
      });
    }
  }

  const server = app.listen(config.port, config.host, () => {
    log.info('Server listening', {
      host: config.host,
      port: config.port,
      env: config.env,
      apiKeyRequired: Boolean(config.apiKey),
    });
  });

  if (config.crawler.enabled) {
    const intervalMs = config.crawler.intervalMinutes * 60_000;

    // Overlap guard.
    //
    // `setInterval` fires on a clock, not on completion, so a cycle that runs
    // long gets a second one started on top of it. At an hourly interval that
    // was unreachable; at one minute it is one upstream 429 away, and stacked
    // crawls compound — each one slower than the last because they share the
    // rate limit that caused the delay.
    let crawlInFlight = false;
    let skipped = 0;

    const tick = async (label) => {
      if (crawlInFlight) {
        skipped += 1;
        // Warn rather than debug: a cycle that never keeps up is a
        // misconfiguration, and it should be visible without raising the level.
        log.warn('Crawl still running, skipping this tick', {
          skippedSinceLastRun: skipped,
          intervalMinutes: config.crawler.intervalMinutes,
        });
        return;
      }

      crawlInFlight = true;
      skipped = 0;
      try {
        await runCrawl();
      } catch (err) {
        log.error(`${label} crawl failed`, { error: err.message });
      } finally {
        crawlInFlight = false;
      }
    };

    // Delay the first crawl so the service is answering requests before it
    // starts a few hundred upstream calls.
    setTimeout(() => {
      tick('Initial');

      crawlTimer = setInterval(() => {
        tick('Scheduled');
      }, intervalMs);
      // Don't let the interval hold the event loop open during shutdown.
      crawlTimer.unref();
    }, 15_000);

    log.info('Meta crawler scheduled', {
      intervalMinutes: config.crawler.intervalMinutes,
    });
  } else {
    log.info('Meta crawler disabled (CRAWLER_ENABLED=false)');
  }

  /**
   * Graceful shutdown: stop accepting connections, let in-flight requests
   * finish, then close Redis. Without this, `systemctl restart` can drop
   * requests mid-flight.
   */
  const shutdown = async (signal) => {
    log.info('Shutting down', { signal });
    if (crawlTimer) clearInterval(crawlTimer);

    server.close(async () => {
      await closeCache();
      await closePool();
      process.exit(0);
    });

    // Backstop if a connection refuses to close.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

boot().catch((err) => {
  log.error('Boot failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
