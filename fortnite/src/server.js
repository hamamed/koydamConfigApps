import path from 'node:path';

import compression from 'compression';
import session from 'express-session';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import morgan from 'morgan';

import { config } from './config.js';
import { migrate } from './db/index.js';
import { adminRouter } from './routes/admin.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { loadUser, flash } from './middleware/auth.js';
import { SqliteSessionStore } from './middleware/session-store.js';
import { apiRouter } from './routes/api.js';
import { wallpapersRouter } from './routes/wallpapers.js';
import { WALLPAPER_ROOT } from './wallpapers/root.js';
import { startSyncLoop } from './sync.js';

migrate();

const app = express();

app.disable('x-powered-by');
// Behind nginx. Without this every client shares the proxy's address and the
// rate limiter throttles the whole internet as one caller.
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(compression());
app.use(express.json({ limit: '256kb' }));
app.use(morgan(config.isProduction ? 'combined' : 'dev'));

// Public and read-only, so any origin may call it. The catalogue is a mirror of
// data that is already public; there is nothing here to protect by origin.
app.use('/api', cors({ origin: '*', methods: ['GET'] }));
app.use(
  '/api',
  rateLimit({
    windowMs: 60_000,
    limit: 240,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  }),
);

// Ahead of apiRouter, which still answers everything else under /api/v1.
app.use('/api/v1', wallpapersRouter);
app.use('/api/v1', apiRouter);

// The images themselves. Long max-age: a wallpaper at a given path never
// changes — a replacement is an upload under a different name.
app.use('/wallpapers', express.static(WALLPAPER_ROOT, {
  maxAge: '30d',
  fallthrough: true,
  index: false,
}));

// ── Panel ───────────────────────────────────────────────────────────────────

app.set('view engine', 'ejs');
app.set('views', path.join(config.root, 'views'));

// Long max-age with a version query on every link: the panel's CSS is
// immutable for a given assetVersion, and a deploy changes the query.
app.use('/assets', express.static(path.join(config.root, 'public'), { maxAge: '7d' }));

app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(
  session({
    name: 'fortnite.sid',
    secret: config.sessionSecret,
    store: new SqliteSessionStore(),
    resave: false,
    saveUninitialized: false,
    // Rolling, so an admin working through a long list is not signed out
    // mid-form by a fixed expiry that started when they logged in.
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction,
      maxAge: 12 * 60 * 60 * 1000,
    },
  }),
);
app.use(flash);
app.use(loadUser);

app.use('/admin', adminRouter);
app.get('/', (_req, res) => res.redirect('/admin'));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use(notFound);
app.use(errorHandler);

const server = app.listen(config.port, config.host, () => {
  console.log(`fortnite listening on http://${config.host}:${config.port}`);
  startSyncLoop();
});

// nginx keeps connections alive for 60s by default; Node's own idle timeout has
// to be longer or the proxy will reuse a socket Node is closing and answer 502.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
