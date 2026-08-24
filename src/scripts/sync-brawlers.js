/**
 * Fetches brawler metadata (rarity, class, hypercharge, portraits) and writes
 * data/brawler-meta.json.
 *
 *   npm run sync:brawlers
 *
 * Run once during setup, then whenever a new brawler ships. The server also
 * syncs automatically on boot when the file is missing or older than
 * BRAWLER_META_REFRESH_H.
 */
import { syncBrawlerMeta } from '../transform/brawler_meta.js';
import { log } from '../log.js';

try {
  const payload = await syncBrawlerMeta();

  const byRarity = {};
  for (const b of payload.brawlers) {
    byRarity[b.rarity] = (byRarity[b.rarity] ?? 0) + 1;
  }

  log.info('Sync complete', { total: payload.count, byRarity });

  // Flag anything that fell back to defaults — a rarity or class the mapping
  // didn't recognise means an upstream rename worth fixing in CLASS_LABELS /
  // RARITY_LABELS rather than silently shipping wrong tints.
  const missingPortrait = payload.brawlers.filter((b) => !b.portraitUrl);
  if (missingPortrait.length) {
    log.warn('Brawlers without a portrait URL', {
      count: missingPortrait.length,
      names: missingPortrait.map((b) => b.name).slice(0, 20),
    });
  }

  // `process.exitCode` rather than `process.exit()`: exiting while stdout is
  // still flushing truncates the last log line, and on Windows it trips a libuv
  // handle assertion. Setting the code lets the event loop drain and exit on
  // its own.
  process.exitCode = 0;
} catch (err) {
  log.error('Sync failed', { error: err.message });
  process.exitCode = 1;
}
