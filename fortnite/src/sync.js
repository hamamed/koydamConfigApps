import { config } from './config.js';
import { db } from './db/index.js';
import { syncCosmetics, syncNews, syncShop } from './upstream.js';
import { pruneMetrics, syncIslandMetrics, syncIslands } from './ecosystem.js';

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

    // Epic's catalogue is north of twenty thousand islands and its metrics
    // endpoint answers one island at a time, so neither job tries to finish in
    // one run — each takes a bounded slice and resumes where it left off.
    { name: 'islands', run: () => syncIslands({ pages: 40 }), minutes: config.refresh.islandsMinutes },
    {
      name: 'island-metrics',
      run: async () => {
        const n = await syncIslandMetrics({ batch: config.refresh.metricsBatch });
        const dropped = pruneMetrics({ days: config.refresh.retentionDays });
        if (dropped) console.log(`pruned ${dropped} metric rows past retention`);
        return n;
      },
      minutes: config.refresh.metricsMinutes,
    },
  ];

  for (const [index, feed] of feeds.entries()) {
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
    //
    // Staggered, and in declaration order. Firing every feed at once put the
    // island-metrics job in front of the catalogue it reads from: on a fresh
    // install it ran six seconds before the first island was stored, found
    // nothing to ask about, recorded a clean run and slept for ten minutes.
    // The delay also stops five upstream requests leaving at the same instant
    // every time the service restarts.
    if (isStale(feed.name, feed.minutes)) {
      const delay = index * 45_000;
      const first = setTimeout(tick, delay);
      first.unref?.();
    }

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
