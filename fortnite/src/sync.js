import { config } from './config.js';
import { db } from './db/index.js';
import { syncCosmetics, syncNews, syncShop } from './upstream.js';

/**
 * Keeps the mirror current.
 *
 * Each feed runs on its own timer because they change on completely different
 * clocks: the shop rotates once a day, news a few times a week, and the
 * cosmetics catalogue only when a patch ships.
 *
 * A feed that fails is left alone until its next turn rather than retried in a
 * tight loop. The previous pull is still in the database and still being
 * served, so a failure is a staleness problem rather than an outage — and
 * hammering an upstream that is already unhappy is how a rate limit becomes a
 * ban.
 */
export function startSyncLoop() {
  const feeds = [
    { name: 'cosmetics', run: syncCosmetics, minutes: config.refresh.cosmeticsMinutes },
    { name: 'shop', run: syncShop, minutes: config.refresh.shopMinutes },
    { name: 'news', run: syncNews, minutes: config.refresh.newsMinutes },
  ];

  for (const feed of feeds) {
    const tick = async () => {
      try {
        const n = await feed.run();
        console.log(`sync ${feed.name}: ${n}`);
      } catch (err) {
        console.warn(`sync ${feed.name} failed: ${err.message}`);
      }
    };

    // On boot, only what is missing or stale. A restart should not re-download
    // 16 MB of cosmetics that were fetched a minute earlier.
    if (isStale(feed.name, feed.minutes)) tick();

    const timer = setInterval(tick, feed.minutes * 60_000);
    // Nothing should be kept alive by a refresh timer.
    timer.unref?.();
  }
}

function isStale(feed, minutes) {
  const row = db.prepare('SELECT last_ok_at FROM sync_state WHERE feed = ?').get(feed);
  if (!row?.last_ok_at) return true;
  return Date.now() - Date.parse(row.last_ok_at) > minutes * 60_000;
}
