import 'dotenv/config';

import { str as liveStr } from './remote-settings.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const resolve = (value, fallback) => path.resolve(root, value || fallback);

export const config = {
  root,
  port: Number(process.env.PORT || 3000),

  /** Interface to bind.
   *
   *  Loopback by default. Binding to 0.0.0.0 on a VPS puts the app on the public internet at
   *  :3000 alongside nginx — same application, but with no TLS, no rate limiting and no access
   *  log. Override only if something other than a local reverse proxy needs to reach it. */
  host: process.env.HOST || '127.0.0.1',
  env: process.env.NODE_ENV || 'development',
  isProduction: (process.env.NODE_ENV || 'development') === 'production',

  /** Absolute base for the URLs handed to clients. Trailing slashes are stripped so that
   *  `${publicUrl}/storage/...` never produces a double slash. */
  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, ''),

  sessionSecret: process.env.SESSION_SECRET || 'insecure-development-secret',

  dataDir: resolve(process.env.DATA_DIR, './data'),
  storageDir: resolve(process.env.STORAGE_DIR, './storage'),

  /**
   * Artwork generation. Off unless a key is present.
   *
   * Speaks the OpenAI images API, which several providers implement - so the
   * base URL is configurable and switching provider needs no code change.
   * Off by default because it costs money per image and because a feature
   * that silently does nothing is worse than one that says it is not set up.
   */
  ai: {
    // Getters, not values: the key is set in the panel and should take effect
    // on the next request rather than on the next restart - the usual reason
    // to change one is that the current one stopped working.
    get apiKey() {
      return liveStr('AI_IMAGE_API_KEY', process.env.AI_IMAGE_API_KEY || '');
    },
    get baseUrl() {
      const raw = liveStr(
        'AI_IMAGE_BASE_URL',
        process.env.AI_IMAGE_BASE_URL || 'https://api.openai.com/v1',
      );
      return String(raw).replace(/\/+$/, '');
    },
    get model() {
      return liveStr('AI_IMAGE_MODEL', process.env.AI_IMAGE_MODEL || 'gpt-image-1');
    },
    /**
     * The planner, which writes the design in words and suggests ideas.
     *
     * On by default, because it is the cheap half of this feature and a key
     * that can draw can also plan. `off` is the switch, and it has to be a
     * word rather than a blank: remote-settings treats an empty panel value as
     * "not set" and falls back, so clearing the field cannot mean anything.
     */
    get textModel() {
      const value = String(
        liveStr('AI_TEXT_MODEL', process.env.AI_TEXT_MODEL || 'gpt-4o-mini'),
      ).trim();
      return /^(off|none|disabled)$/i.test(value) ? '' : value;
    },
  },

  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 12) * 1024 * 1024,

  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  /// Universal-link identity. Both appear verbatim in the app-site-association file, so they
  /// must match the shipping app exactly — a mismatch fails silently: iOS just opens Safari.
  appleTeamID: process.env.APPLE_TEAM_ID || 'TEAMID',
  iosBundleID: process.env.IOS_BUNDLE_ID || 'koydam.skincraft.for.roblox',

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

// Loud, because the alternative is silent. A placeholder team id still serves a
// syntactically valid app-site-association file, so every check short of opening a
// shared link on a real iPhone passes — and that link just opens Safari instead of
// the app. Warn rather than throw: universal links are a feature, not a dependency,
// and a server that refuses to boot over one is worse than a server without them.
if (config.isProduction && config.appleTeamID === 'TEAMID') {
  console.warn(
    '[config] APPLE_TEAM_ID is still the placeholder "TEAMID". Universal links will not ' +
      'work: iOS will silently open shared /s/ links in Safari instead of the app. Set ' +
      'APPLE_TEAM_ID to your Apple Developer Team ID and restart.'
  );
}
