import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import morgan from 'morgan';
import path from 'node:path';
import { config } from './config.js';
import { startRemoteSettings } from './remote-settings.js';
import { migrate } from './db/index.js';
import { SqliteSessionStore } from './middleware/session-store.js';
import { loadUser, flash } from './middleware/auth.js';
import { notFound, errorHandler } from './middleware/errors.js';
import { ensureStorageDirs } from './services/images.js';
import { apiRouter } from './routes/api.js';
import { shareRouter } from './routes/share.js';
import { adminRouter } from './routes/admin.js';
import { formatBytes, formatNumber, formatDate, timeAgo, sparklinePath } from './utils/format.js';

migrate();
await ensureStorageDirs();

const app = express();

// Behind nginx, so the client IP for rate limiting and download fingerprints comes from
// X-Forwarded-For. Trusting exactly one hop — trusting them all lets a client spoof its IP.
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(config.root, 'views'));

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Bootstrap and Lucide are served from jsDelivr; everything else is same-origin.
        scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
        // Google Fonts is two hosts, and both are needed: the stylesheet comes
        // from fonts.googleapis.com and the faces it names come from
        // fonts.gstatic.com. head.ejs has asked for Inter all along while the
        // policy blocked it, so every panel has been rendering in the fallback
        // face — silently, because a blocked stylesheet is not a broken one.
        styleSrc: [
          "'self'", "'unsafe-inline'",
          'https://cdn.jsdelivr.net',
          'https://fonts.googleapis.com',
        ],
        fontSrc: [
          "'self'",
          'https://cdn.jsdelivr.net',
          'https://fonts.gstatic.com',
          'data:',
        ],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.isProduction ? [] : null,
      },
    },
    // Assets are fetched cross-origin by the mobile app; the default policy blocks that.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

app.use(compression());
app.use(morgan(config.isProduction ? 'combined' : 'dev'));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(express.json({ limit: '256kb' }));

app.use(
  session({
    name: 'skincraft.sid',
    secret: config.sessionSecret,
    store: new SqliteSessionStore(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction,
      maxAge: 12 * 60 * 60 * 1000,
    },
  })
);

app.use(loadUser);
app.use(flash);

// Cache-buster for the admin's own CSS and JS.
//
// `/assets` is served with a long max-age, which is right for production and actively hostile
// during development: a style change lands but every already-open browser keeps the old file.
// Stamping the boot time onto the URLs means a restart is enough to pick up changes.
app.locals.assetVersion = Date.now().toString(36);

// View helpers, available to every template without importing anything.
app.locals.formatBytes = formatBytes;
app.locals.formatNumber = formatNumber;
app.locals.formatDate = formatDate;
app.locals.timeAgo = timeAgo;
app.locals.sparklinePath = sparklinePath;

// MARK: - Public asset serving
//
// Long-lived caching is safe because filenames are content-scoped: replacing a template reuses
// its filename only when the admin explicitly replaces that asset, and clients revalidate.
app.use(
  '/storage',
  cors({ origin: config.corsOrigins.length ? config.corsOrigins : true }),
  express.static(config.storageDir, {
    maxAge: '7d',
    etag: true,
    index: false,
    dotfiles: 'ignore',
    setHeaders(res) {
      res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    },
  })
);

app.use('/assets', express.static(path.join(config.root, 'public'), { maxAge: '1d' }));

// MARK: - Routes

app.use(
  '/api/v1',
  cors({ origin: config.corsOrigins.length ? config.corsOrigins : true }),
  apiRouter
);
app.use('/admin', adminRouter);

// Public share links and the app-site-association file live at the domain root.
app.use('/', shareRouter);

app.get('/', (req, res) => res.redirect('/admin'));

app.use(notFound);
app.use(errorHandler);

// Settings from the panel, layered over .env. Started here rather than awaited:
// nothing in the first few requests needs the AI key, and a slow or unreachable
// panel must not delay the port opening.
startRemoteSettings('skincraft', {
  info: (msg) => console.log('  ' + msg),
  warn: (msg, d) => console.warn('  ' + msg, d ?? ''),
}).catch(() => {});

const server = app.listen(config.port, config.host, () => {
  console.log(`  SkinCraft API   ${config.publicUrl}/api/v1/skins`);
  console.log(`  Admin panel     ${config.publicUrl}/admin`);
  console.log(`  Listening on    ${config.host}:${config.port} (${config.env})`);
});

/**
 * Outlive nginx's idea of how long a connection is good for.
 *
 * The upstream block keeps up to 16 connections pooled and reuses them, and it
 * has no idle timeout of its own — it assumes a pooled connection stays usable
 * until it is told otherwise. Node closes an idle one after five seconds.
 *
 * Most of the time nothing notices, because traffic keeps them warm. An AI
 * generation is the exception: it runs for a minute or more during which the
 * browser asks for nothing else, so every pooled connection goes stale. The
 * navigation to the finished draft is then sent into a socket that is already
 * gone, nginx answers 502, and Chrome shows "this page isn't working" — while a
 * refresh, which opens a fresh connection, works. That is the shape of the bug
 * exactly.
 *
 * headersTimeout must stay above keepAliveTimeout, or it fires first and
 * undoes this.
 */
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

/**
 * One bad request must not take the site down.
 *
 * Express does not catch a rejected async handler, and Node's default for an
 * unhandled rejection is to exit. On this box that means the admin panel, the
 * public catalogue API and the app's config fetch all stop together, and nginx
 * answers 503 until systemd restarts us — a page that should have shown one
 * error instead becomes an outage for everyone, including the mobile app.
 *
 * Logged loudly rather than swallowed: the request that caused it still hangs
 * and still needs fixing, and this line is how it gets found.
 */
process.on('unhandledRejection', (reason) => {
  console.error('  Unhandled rejection — the request that caused it will hang:', reason);
});

// Let in-flight requests finish before the process exits, so a deploy never truncates an upload.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`\n  ${signal} received, shutting down.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
