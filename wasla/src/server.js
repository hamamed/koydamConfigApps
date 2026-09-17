import path from 'node:path';

import compression from 'compression';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import session from 'express-session';
import helmet from 'helmet';
import morgan from 'morgan';

import { createApnsSender } from './apns.js';
import { createApnsCredentials } from './apns-credentials.js';
import { createAppConfig } from './app-config.js';
import { createAudioStore } from './audio.js';
import { config } from './config.js';
import { createDaily } from './daily.js';
import { createDailyGames } from './daily-games.js';
import { createDevices } from './devices.js';
import { db } from './db/index.js';
import { createEvents } from './events.js';
import { createImageStore } from './images.js';
import { createMaintenance } from './maintenance.js';
import { createNotifications } from './notifications.js';
import { createPlayers } from './players.js';
import { createProfiles } from './profiles.js';
import { loadUser, flash } from './middleware/auth.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { SqliteSessionStore } from './middleware/session-store.js';
import { createPendingImports } from './pending-imports.js';
import { createRepository } from './repository.js';
import { createSiteSettings } from './site-settings.js';
import { createWordSearch } from './wordsearch-daily.js';
import { createWordSearchSchedule } from './wordsearch-schedule.js';
import { adminRouter } from './routes/admin.js';
import { apiRouter } from './routes/api.js';
import { challengeRouter } from './routes/challenge.js';
import { legalRouter } from './routes/legal.js';

const repo = createRepository(db);
const images = createImageStore(config.imagesDir, { maxBytes: config.maxImageBytes });
const audio = createAudioStore(config.audioDir, { maxBytes: config.maxAudioBytes });
const daily = createDaily(db, repo);
const appConfig = createAppConfig(db);
const events = createEvents(db, repo);
const pendingImports = createPendingImports(db);
const devices = createDevices(db);
const siteSettings = createSiteSettings(db, { envAppStoreUrl: config.appStoreUrl });
const apnsCredentials = createApnsCredentials(db, { dir: config.apnsDir });
const notifications = createNotifications(db, { devices, credentials: apnsCredentials, sender: createApnsSender() });
const players = createPlayers(db, { repo });
const wordSearch = createWordSearch(db, { appConfig });
const wordSearchDays = createWordSearchSchedule(db, { wordSearch, appConfig });
const dailyGames = createDailyGames(db, { appConfig });
const profiles = createProfiles(db);

const app = express();

app.disable('x-powered-by');
// Behind nginx; without this every player shares the proxy's address.
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(compression());
app.use(morgan(config.isProduction ? 'combined' : 'dev'));

app.use('/api', cors({ origin: '*', methods: ['GET', 'POST'] }));
app.use('/api', rateLimit({
  windowMs: 60_000,
  limit: 240,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many requests. Try again in a minute.' }),
}));
app.use('/api/v1', apiRouter({ repo, publicUrl: config.publicUrl, daily, appConfig, events, devices, wordSearch, wordSearchDays, dailyGames, profiles }));

// Question pictures and sounds. A replaced file gets a new generated name, so
// a file at a given name never changes and can be cached for a long time.
app.use('/media/questions', express.static(config.imagesDir, { maxAge: '30d', immutable: true, index: false }));
app.use('/media/audio', express.static(config.audioDir, { maxAge: '30d', immutable: true, index: false }));

// ── Panel ────────────────────────────────────────────────────────────────────

app.set('view engine', 'ejs');
// The error page shares the panel's head and foot, which version their assets.
// Set app-wide: a 404 outside /admin never passes through the admin router,
// and rendering it used to throw and turn every missing file into a 500.
app.locals.assetVersion = config.assetVersion;
app.set('views', path.join(config.root, 'views'));
app.use('/assets', express.static(path.join(config.root, 'public'), { maxAge: '7d' }));

// Challenge links and the apple-app-site-association file iOS fetches for
// them. Public, no session, and ahead of the 404 handler.
app.use(challengeRouter({ repo, publicUrl: config.publicUrl, siteSettings, assetVersion: config.assetVersion }));

// Public pages the App Store listing links to. No session needed.
app.use(legalRouter({ assetVersion: config.assetVersion }));

app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(session({
  name: 'wasla.sid',
  secret: config.sessionSecret,
  store: new SqliteSessionStore(),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProduction, maxAge: 12 * 60 * 60 * 1000 },
}));
app.use(flash);
app.use(loadUser);

app.use('/admin', adminRouter({
  repo, images, audio, appConfig, events, pendingImports, siteSettings, devices, notifications, apnsCredentials, players, wordSearch, wordSearchDays, dailyGames, profiles,
}));
app.get('/', (_req, res) => res.redirect('/admin'));
app.get('/health', (_req, res) => res.json({ ok: true }));

app.use(notFound);
app.use(errorHandler);

const server = app.listen(config.port, config.host, () => {
  console.log(`wasla listening on http://${config.host}:${config.port}`);
});

// Longer than nginx's keep-alive, or the proxy reuses a socket Node is closing.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

createMaintenance({
  repo, events, pendingImports, images, audio, retentionDays: config.eventRetentionDays,
}).start();

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
