import 'dotenv/config';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const resolve = (value, fallback) => path.resolve(root, value || fallback);

export const config = {
  root,
  port: Number(process.env.PORT || 3100),

  /** Interface to bind.
   *
   *  Loopback by default. Binding to 0.0.0.0 on a VPS puts the app on the public internet at
   *  :3100 alongside nginx — same application, but with no TLS, no rate limiting and no access
   *  log. Override only if something other than a local reverse proxy needs to reach it. */
  host: process.env.HOST || '127.0.0.1',
  env: process.env.NODE_ENV || 'development',
  isProduction: (process.env.NODE_ENV || 'development') === 'production',

  /** Absolute base for the URLs handed to clients. Trailing slashes are stripped so that
   *  `${publicUrl}/storage/...` never produces a double slash. */
  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:3100').replace(/\/+$/, ''),

  sessionSecret: process.env.SESSION_SECRET || 'insecure-development-secret',

  dataDir: resolve(process.env.DATA_DIR, './data'),
  storageDir: resolve(process.env.STORAGE_DIR, './storage'),

  /**
   * Upload ceiling.
   *
   * Much higher than a skin catalogue needs, because the same route accepts
   * .mcworld archives — an adventure map with a rendered spawn town is tens of
   * megabytes where a skin is six kilobytes. Per-kind ceilings live in
   * `utils/validate.js`; this is the outer bound multer enforces before a byte
   * reaches the application.
   */
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 64) * 1024 * 1024,

  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  /// Universal-link identity. Both appear verbatim in the app-site-association file, so they
  /// must match the shipping app exactly — a mismatch fails silently: iOS just opens Safari.
  appleTeamID: process.env.APPLE_TEAM_ID || 'TEAMID',
  iosBundleID: process.env.IOS_BUNDLE_ID || 'com.koydam.minebox',

  bootstrapAdmin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || '',
  },

  /** Page-size ceiling for the public API. Without a cap, `?limit=100000` is a free denial of
   *  service against your own database. */
  maxPageSize: 60,
  defaultPageSize: 20,
};

if (config.isProduction && config.sessionSecret === 'insecure-development-secret') {
  throw new Error('SESSION_SECRET must be set in production. See .env.example.');
}
