/**
 * Runs one meta crawl and exits.
 *
 *   npm run crawl:meta
 *
 * Useful for two things: populating /meta/tierlist immediately instead of
 * waiting for the scheduler, and running the crawl from cron with
 * CRAWLER_ENABLED=false if you'd rather the web process not do it.
 *
 * Writes to the same cache the server reads, so REDIS_URL must match — with the
 * in-memory fallback this process writes to its own memory and exits, and the
 * server never sees the result.
 */
import { loadBrawlerMeta } from '../transform/brawler_meta.js';
import { runCrawl } from '../crawler/meta_crawler.js';
import { closeCache } from '../cache/store.js';
import { config } from '../config.js';
import { log } from '../log.js';

if (!config.redis.url) {
  log.warn(
    'REDIS_URL is not set — this crawl writes to process memory and will be lost on exit. Set REDIS_URL so the server can read the result.',
  );
}

try {
  // Metadata must be loaded first or the tier list ships without rarity/class.
  await loadBrawlerMeta();

  const payload = await runCrawl();

  log.info('Crawl finished', {
    battles: payload.sample.battlesAnalysed,
    players: payload.sample.playersSampled,
    modes: Object.keys(payload.modes).length,
    maps: Object.keys(payload.maps).length,
  });

  await closeCache();
  // See the note in sync-brawlers.js — exitCode, not exit().
  process.exitCode = 0;
} catch (err) {
  log.error('Crawl failed', { error: err.message, stack: err.stack });
  await closeCache();
  process.exitCode = 1;
}
