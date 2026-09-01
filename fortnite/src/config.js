import 'dotenv/config';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const config = {
  root,
  port: num(process.env.PORT, 3200),

  /** Loopback by default: binding 0.0.0.0 on a VPS publishes the app on :3200
   *  beside nginx, with no TLS, no rate limiting and no access log. */
  host: process.env.HOST || '127.0.0.1',
  env: process.env.NODE_ENV || 'development',
  isProduction: (process.env.NODE_ENV || 'development') === 'production',

  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:3200').replace(/\/+$/, ''),
  dataDir: path.resolve(root, process.env.DATA_DIR || './data'),

  sessionSecret: process.env.SESSION_SECRET || 'insecure-development-secret',

  upstream: {
    base: 'https://fortnite-api.com',
    key: process.env.FORTNITE_API_KEY || '',
    language: process.env.FORTNITE_LANGUAGE || 'en',
  },

  refresh: {
    shopMinutes: num(process.env.SHOP_REFRESH_MINUTES, 10),
    newsMinutes: num(process.env.NEWS_REFRESH_MINUTES, 30),
    cosmeticsMinutes: num(process.env.COSMETICS_REFRESH_MINUTES, 720),
  },

  platformUrl: (process.env.PLATFORM_URL || '').replace(/\/+$/, ''),
  serviceToken: process.env.SERVICE_TOKEN || '',
  allowedRedirectHosts: (process.env.ALLOWED_REDIRECT_HOSTS || '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean),

  /** Page-size ceiling for the public API. Without a cap, `?limit=100000`
   *  returns all sixteen thousand cosmetics and their images in one response. */
  /** Cache-buster for the panel's own CSS and JS. Bumped by a deploy, so a
   *  stylesheet change is not invisible behind a week-old cached copy. */
  assetVersion: process.env.ASSET_VERSION || String(Date.now()),

  maxPageSize: 100,
  defaultPageSize: 40,
};

if (config.isProduction && config.sessionSecret === 'insecure-development-secret') {
  throw new Error('SESSION_SECRET must be set in production. See .env.example.');
}
