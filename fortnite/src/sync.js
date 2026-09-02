import { config } from './config.js';
import { pruneMedia } from './media.js';
import { db } from './db/index.js';
import { syncCosmetics, syncNews, syncShop } from './upstream.js';
import { adoptPastedIslands, backfillIslandArt, pruneMetrics, syncIslandMetrics, syncIslands } from './ecosystem.js';

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
    {
      name: 'islands',
      run: async () => {
        const n = await syncIslands({ pages: 40 });
        const { adopted } = await adoptPastedIslands();
        if (adopted) console.log(`pulled ${adopted} pasted islands in by code`);
        const art = backfillIslandArt();
        if (art) console.log(`attached artwork to ${art} newly synced islands`);
        return n;
      },
      minutes: config.refresh.islandsMinutes,
    },
    {
      name: 'island-metrics',
      run: async () => {
        const n = await syncIslandMetrics({
          batch: config.refresh.metricsBatch,
          exploreShare: config.refresh.metricsExploreShare,
          concurrency: config.refresh.metricsConcurrency,
        });
        const dropped = pruneMetrics({ days: config.refresh.retentionDays });
        if (dropped) console.log(`pruned ${dropped} metric rows past retention`);
        const evicted = pruneMedia();
        if (evicted) console.log(`evicted ${evicted} cached images over budget`);
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

  scheduleNightlyRefresh(feeds);
}

/**
 * One pass over every feed at 01:00 in Paris, whatever the interval timers did.
 *
 * The per-feed timers keep things current through the day but they drift: a
 * service restarted at 09:14 pulls the shop at 09:24, 09:34 and so on for as
 * long as it runs, so the hour any feed refreshes depends on when the box last
 * rebooted. A fixed nightly pass gives one moment each day when everything is
 * known to be current — after Fortnite's own daily rotation, and before the
 * backup at 02:30 takes its archive.
 *
 * A feed refreshed within the last few hours is skipped. The point is to
 * guarantee freshness, not to spend an upstream request re-proving that
 * something fetched twenty minutes ago is still what it was.
 */
function scheduleNightlyRefresh(feeds) {
  const run = async () => {
    for (const feed of feeds) {
      if (!isStale(feed.name, config.refresh.nightlyStaleMinutes)) {
        console.log(`nightly ${feed.name}: already fresh, skipped`);
        continue;
      }
      try {
        console.log(`nightly ${feed.name}: ${await feed.run()}`);
      } catch (err) {
        console.warn(`nightly ${feed.name} failed: ${err.message}`);
      }
    }
    // Re-armed from the end of the run rather than on a fixed interval, so a
    // pass that takes twenty minutes does not walk the schedule earlier each
    // night until it drifts out of the small hours entirely.
    schedule();
  };

  const schedule = () => {
    const wait = millisecondsUntilNightly();
    const timer = setTimeout(run, wait);
    timer.unref?.();
    console.log(`nightly refresh in ${Math.round(wait / 60_000)} minutes`);
  };

  schedule();
}

/**
 * How long until the next 01:00 Europe/Paris.
 *
 * Computed against the named zone rather than a fixed UTC hour so it stays at
 * 01:00 for a reader in Paris across the daylight-saving change, when the
 * offset moves from +1 to +2. Hardcoding `00:00 UTC` would quietly become
 * midnight for half the year.
 */
function millisecondsUntilNightly() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.refresh.nightlyZone, hour12: false,
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date());
  const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);

  const secondsNow = (get('hour') % 24) * 3600 + get('minute') * 60 + get('second');
  const ahead = config.refresh.nightlyHour * 3600 - secondsNow;

  // Past today's hour already, so aim at tomorrow's.
  return (ahead > 0 ? ahead : ahead + 86_400) * 1000;
}

function isStale(feed, minutes) {
  const row = db.prepare('SELECT last_ok_at FROM sync_state WHERE feed = ?').get(feed);
  if (!row?.last_ok_at) return true;
  return Date.now() - Date.parse(row.last_ok_at) > minutes * 60_000;
}
