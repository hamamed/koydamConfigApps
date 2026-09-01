import compression from 'compression';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import morgan from 'morgan';

import { config } from './config.js';
import { migrate } from './db/index.js';
import { apiRouter } from './routes/api.js';
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

app.use('/api/v1', apiRouter);

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use((_req, res) => res.status(404).json({ status: 'error', message: 'Not found' }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ status: 'error', message: 'Something went wrong' });
});

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
