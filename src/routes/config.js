import { Router } from 'express';

import { config } from '../config.js';
import { appConfig, recordFetch } from '../db/repo.js';
import { log } from '../log.js';

/**
 * The public read path. One request, everything an app needs at launch.
 *
 * Deliberately unauthenticated. The response contains AdMob unit ids, which
 * are not secrets — they ship inside every APK and IPA already, and anyone can
 * read them out of a binary in minutes. Gating this would add a shared secret
 * to every client for no protection, and a client that cannot reach its config
 * is a client with no kill switch.
 */
export const configRouter = Router();

const PLATFORMS = new Set(['ios', 'android']);

configRouter.get('/v1/apps/:slug/config', async (req, res) => {
  const slug = String(req.params.slug ?? '').toLowerCase();
  const platform = String(req.query.platform ?? '').toLowerCase();

  if (!PLATFORMS.has(platform)) {
    return res.status(400).json({
      error: 'bad_platform',
      message: "Pass ?platform=ios or ?platform=android.",
    });
  }

  // Read before assembling, not only for the fetch counter: announcements and
  // release notes are targeted by it.
  const version = typeof req.query.version === 'string'
    ? req.query.version.slice(0, 32)
    : null;

  const result = await appConfig(slug, platform, version);

  if (!result) {
    // 404 rather than an empty config: a client that gets `{}` would read it
    // as "ads disabled, no flags" and behave as though that were deliberate.
    return res.status(404).json({
      error: 'unknown_app',
      message: `No config for '${slug}' on ${platform}.`,
    });
  }

  // Fire and forget. A counter must never delay or fail the response the app
  // is waiting on before it can draw its first screen.
  if (config.trackFetches) {
    Promise.resolve()
      .then(() => recordFetch(slug, platform, version))
      .catch((err) => log.debug('Fetch counter failed', { error: err.message }));
  }

  // Short cache. Long enough that a popular app is not asking on every cold
  // start, short enough that switching ads off takes effect in minutes rather
  // than whenever clients happen to restart.
  res.set('Cache-Control', `public, max-age=${config.clientCacheSeconds}`);
  res.json({ ...result, fetchedAt: new Date().toISOString() });
});

/**
 * Every app this server knows about.
 *
 * Useful for a launcher or a status page, and for checking a deploy landed.
 * Names and slugs only — nothing configured, nothing sensitive.
 */
configRouter.get('/v1/apps', async (_req, res) => {
  const { listApps } = await import('../db/repo.js');
  const apps = await listApps();

  res.json({
    apps: apps.map((a) => ({
      slug: a.slug,
      name: a.name,
      platforms: (a.platforms ?? []).map((p) => p.platform),
    })),
  });
});
