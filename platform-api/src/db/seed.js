/**
 * Creates the apps this VPS actually serves, with working defaults.
 *
 * A fresh install has an empty database and an empty panel, which looks broken
 * rather than new. This fills it with the two real apps so the panel has
 * something to show and a client gets a valid response immediately.
 *
 * **Ad unit ids are Google's public test units.** That is deliberate: a config
 * service that hands out live ids before anyone has entered them would be worse
 * than one that hands out test ids, because test ads are obvious and live ads
 * requested from a dev build are invalid traffic — which gets AdMob accounts
 * suspended weeks later with no appeal.
 *
 * Safe to re-run: every write is an upsert, so it will not clobber ids you have
 * since entered in the panel... with one exception, noted on ADMOB_TEST below.
 *
 *   npm run seed
 */

import { getPool, isDbEnabled } from './pool.js';
import { runMigrations } from './migrate.js';
import {
  upsertAdUnit,
  upsertApp,
  upsertFlag,
  upsertPacing,
  upsertPlatform,
} from './repo.js';
import { log } from '../log.js';

/** Google's documented test units. They always fill, and they earn nothing. */
const ADMOB_TEST = {
  ios: {
    appId: 'ca-app-pub-3940256099942544~1458002511',
    banner: 'ca-app-pub-3940256099942544/2934735716',
    interstitial: 'ca-app-pub-3940256099942544/4411468910',
    native: 'ca-app-pub-3940256099942544/3986624511',
    appOpen: 'ca-app-pub-3940256099942544/5575463023',
  },
  android: {
    appId: 'ca-app-pub-3940256099942544~3347511713',
    banner: 'ca-app-pub-3940256099942544/6300978111',
    interstitial: 'ca-app-pub-3940256099942544/1033173712',
    native: 'ca-app-pub-3940256099942544/2247696110',
    appOpen: 'ca-app-pub-3940256099942544/9257395921',
  },
};

/**
 * Matches the defaults compiled into the Brawl app's AdConfig.
 *
 * Seeded with the same numbers so switching the client from its built-in values
 * to the server changes nothing on day one — the point of the move is being
 * able to tune later, not to change behaviour the moment it ships.
 */
const PACING = {
  interstitialWarmup: 8,
  interstitialCooldownSeconds: 180,
  appOpenMinimumBackgroundSeconds: 30,
  appOpenCooldownSeconds: 900,
  appOpenMaxCacheHours: 4,
};

const APPS = [
  {
    slug: 'brawl-stats',
    name: 'Brawl Stats',
    notes: 'Companion app for Brawl Stars. Backend: api.hamaprojects.com',
    platforms: {
      ios: { bundleId: 'com.brawlstats.brawlStats' },
      android: { bundleId: 'com.brawlstats.brawlStats' },
    },
    flags: {
      // Reads /players/:tag/stats, which needs migrations 004/005 and a few
      // days of crawling before it has anything to show.
      careerStats: true,
      duos: true,
      draft: true,
      wallpapers: true,
    },
  },
  {
    slug: 'skincraft',
    name: 'SkinCraft for Roblox',
    notes: 'Skin catalogue. Backend: skincraft.hamaprojects.com',
    platforms: {
      ios: { bundleId: 'com.skincraft.roblox' },
    },
    flags: { reporting: true },
  },
];

async function seed() {
  if (!isDbEnabled()) {
    log.error('POSTGRES_URL not set');
    process.exit(1);
  }

  await runMigrations();

  for (const app of APPS) {
    await upsertApp({ slug: app.slug, name: app.name, notes: app.notes });
    log.info('App', { slug: app.slug });

    for (const [platform, fields] of Object.entries(app.platforms)) {
      const test = ADMOB_TEST[platform];

      await upsertPlatform(app.slug, platform, {
        ...fields,
        admobAppId: test.appId,
        adsEnabled: true,
        maintenance: false,
      });

      for (const placement of ['banner', 'interstitial', 'native', 'appOpen']) {
        await upsertAdUnit(app.slug, platform, placement, test[placement], true);
      }

      await upsertPacing(app.slug, platform, PACING);
      log.info('  platform', { platform, units: 4 });
    }

    // Null platform: applies to both. Overriding one platform later is a row
    // that wins over this one rather than an edit to it.
    for (const [key, value] of Object.entries(app.flags ?? {})) {
      await upsertFlag(app.slug, null, key, value);
    }
  }

  log.warn('Seeded with Google TEST ad unit ids — replace them in the panel', {
    panel: '/admin?key=…',
  });

  await getPool()?.end();
}

seed().catch((err) => {
  log.error('Seed failed', { error: err.message });
  process.exit(1);
});
