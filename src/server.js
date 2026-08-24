import compression from 'compression';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

import { config } from './config.js';
import { log } from './log.js';
import { sweepSessions } from './auth.js';
import { closePool, dbHealth } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { bootstrapOwner, seedServices } from './db/bootstrap.js';
import { checkAllServices, pruneChecks } from './health-monitor.js';
import { authRouter } from './routes/auth.js';
import { configRouter } from './routes/config.js';
import { dashboardRouter } from './routes/dashboard.js';
import { panelRouter } from './routes/panel.js';
import { ssoRouter } from './routes/sso.js';

const app = express();

/**
 * Needed for correct client IPs behind nginx. Without it express-rate-limit
 * and the audit log see every request as 127.0.0.1 — which makes the login
 * throttle a global one and the audit trail useless.
 */
app.set('trust proxy', 1);

app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        // Scripts and styles are served from this origin only. Inline is
        // blocked, which is why the panel's JS lives in files.
        'script-src': ["'self'"],
        // Google Fonts, and nothing else. The dashboard shares its typeface
        // with the rest of the Koydam design system; the alternative is
        // vendoring four font files to save one hostname.
        'style-src': ["'self'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        // Dropped: on a plain-HTTP deployment it rewrites every request to
        // https:// and then fails, because there is no certificate yet.
        'upgrade-insecure-requests': null,
      },
    },
    // The panel is same-origin only; the default would block the font CSS.
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(compression());
app.use(express.json({ limit: '256kb' }));

// The public config endpoint is read by mobile clients, which send no Origin
// header. The dashboard is same-origin and needs no CORS at all.
app.use('/v1', cors({ origin: '*', methods: ['GET'] }));

app.use(
  rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    // Health must never be throttled or a load balancer reads the service as
    // down under load. Panel assets are exempt because one page load is a
    // dozen files and a throttled stylesheet renders the dashboard unusable.
    skip: (req) => req.path === '/health' || req.path.startsWith('/panel/'),
    message: { error: 'rate_limited', message: 'Too many requests.' },
  }),
);

app.get('/health', async (_req, res) => {
  res.json({
    status: 'ok',
    service: 'platform-api',
    env: config.env,
    uptimeSeconds: Math.round(process.uptime()),
    db: await dbHealth(),
  });
});

app.use(panelRouter);
app.use(authRouter);
// Service-to-service: how the Brawl and SkinCraft panels resolve a session.
app.use(ssoRouter);
app.use(dashboardRouter);
app.use(configRouter);

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

// Four arguments, or Express does not treat it as an error handler.
app.use((err, _req, res, _next) => {
  log.error('Unhandled error', { message: err.message });
  res.status(500).json({ error: 'internal_error', message: 'Something went wrong.' });
});

// ── Boot ────────────────────────────────────────────────────────────────────

let timers = [];

async function boot() {
  // Before listening. Serving config against an unmigrated database would 404
  // every app, which looks exactly like someone deleted them.
  const ready = await runMigrations();
  if (!ready) {
    log.error('Refusing to start without a database');
    process.exit(1);
  }

  await bootstrapOwner();
  await seedServices();

  const server = app.listen(config.port, config.host, () => {
    log.info('platform-api listening', {
      host: config.host,
      port: config.port,
      env: config.env,
    });
  });

  // Health checks. Every minute is often enough to notice an outage and rare
  // enough that it is not itself traffic worth worrying about.
  const check = async () => {
    try {
      await checkAllServices();
    } catch (err) {
      log.warn('Health sweep failed', { error: err.message });
    }
  };
  await check();
  timers.push(setInterval(check, 60_000));

  // Housekeeping. Hourly: expired sessions and old check history are both
  // cheap to carry for an extra hour and pointless to sweep more often.
  timers.push(
    setInterval(async () => {
      await sweepSessions().catch(() => {});
      await pruneChecks().catch(() => {});
    }, 3_600_000),
  );

  for (const t of timers) t.unref();

  const shutdown = (signal) => {
    log.info('Shutting down', { signal });
    for (const t of timers) clearInterval(t);
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 8_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

boot().catch((err) => {
  log.error('Boot failed', { error: err.message });
  process.exit(1);
});
