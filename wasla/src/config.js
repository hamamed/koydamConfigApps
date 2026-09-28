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
  port: num(process.env.PORT, 3700),

  /** Loopback by default: nginx is the only thing that should reach it. */
  host: process.env.HOST || '127.0.0.1',
  env: process.env.NODE_ENV || 'development',
  isProduction: (process.env.NODE_ENV || 'development') === 'production',

  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:3700').replace(/\/+$/, ''),
  /** Where the landing page, privacy, support and credits live, e.g. https://chabbek.com. Empty keeps them on publicUrl. */
  siteUrl: (process.env.SITE_URL || '').trim().replace(/\/+$/, ''),
  /**
   * The old domains that still serve the app and the panel, whose public pages go
   * to the site: LEGACY_HOSTS (comma-separated), and PUBLIC_URL's own host while it
   * is not the site — so moving PUBLIC_URL to the site never strands the old one.
   */
  get legacyHosts() {
    const listed = (process.env.LEGACY_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
    const own = this.publicUrl ? new URL(this.publicUrl).hostname.toLowerCase() : '';
    return [...new Set([...listed, own].filter(Boolean))];
  },
  /** The absolute base every public page, sitemap and link preview is addressed at. */
  get siteBase() { return this.siteUrl || this.publicUrl; },
  dataDir: path.resolve(root, process.env.DATA_DIR || './data'),

  /** The APNs .p8 key uploaded in the panel. Under data/, which deploys preserve. */
  apnsDir: path.resolve(root, process.env.APNS_DIR || path.join(process.env.DATA_DIR || './data', 'apns')),

  /** The Facebook Page key set on the panel's النشر التلقائي. Under data/, which deploys preserve. */
  metaDir: path.resolve(root, process.env.META_DIR || path.join(process.env.DATA_DIR || './data', 'meta')),

  /** The images scheduled posts put out, served for Meta to fetch. Under /storage, which deploys preserve. */
  postsDir: path.resolve(root, process.env.POSTS_DIR || './storage/posts'),

  /** The App Store link on the challenge page; the panel's Settings value wins when set. */
  appStoreUrl: (process.env.APP_STORE_URL || '').trim(),

  /** Question pictures. Under /storage, which deploys preserve. */
  imagesDir: path.resolve(root, process.env.IMAGES_DIR || './storage/questions'),
  maxImageBytes: num(process.env.MAX_IMAGE_BYTES, 8 * 1024 * 1024),

  /**
   * The panel's icons: the game's own icon pack, in the same outline style the
   * app draws. They are a bought asset whose licence allows using them in a
   * project but not redistributing them, and this repository is public — so
   * they live under /storage (which deploys preserve and git never sees) and
   * are served only to a signed-in admin. With the folder empty the panel falls
   * back to Lucide, so nothing breaks on a checkout that has never seen them.
   */
  iconsDir: path.resolve(root, process.env.ICONS_DIR || './storage/icons'),

  /** Question sounds, beside the pictures under /storage. */
  audioDir: path.resolve(root, process.env.AUDIO_DIR || './storage/audio'),
  maxAudioBytes: num(process.env.MAX_AUDIO_BYTES, 5 * 1024 * 1024),

  /** Gameplay events older than this are deleted, daily. */
  eventRetentionDays: num(process.env.EVENT_RETENTION_DAYS, 180),

  sessionSecret: process.env.SESSION_SECRET || 'insecure-development-secret',

  platformUrl: (process.env.PLATFORM_URL || '').replace(/\/+$/, ''),
  serviceToken: process.env.SERVICE_TOKEN || '',

  /** Cache-buster for the panel's CSS and JS; a restart changes it. */
  assetVersion: process.env.ASSET_VERSION || String(Date.now()),
};

if (config.isProduction && config.sessionSecret === 'insecure-development-secret') {
  throw new Error('SESSION_SECRET must be set in production. See .env.example.');
}
