import { config } from './config.js';
import { dbHealth } from './db/pool.js';
import { latestStandings, panelSummary, recentRuns, tableSizes, topMovers, universeStats } from './db/meta_repo.js';
import { browsableTables, tableCounts } from './db/browse_repo.js';
import { currentSourceName } from './db/source.js';
import { metaStats } from './transform/brawler_meta.js';

/**
 * Everything an operations screen shows, in one object: the old panel at
 * /admin/data and the control panel's /internal/overview both serve this, so
 * the two can never disagree about what the crawler is doing.
 */
export async function panelData() {
  const [db, summary, runs, standings, movers, sizes, universe, counts] = await Promise.all([
    dbHealth(),
    panelSummary(),
    recentRuns(15),
    latestStandings(25),
    topMovers({ days: 7, limit: 8 }),
    tableSizes(),
    universeStats(),
    tableCounts(),
  ]);

  return {
    now: new Date().toISOString(),
    db,
    crawler: {
      enabled: config.crawler.enabled,
      intervalMinutes: config.crawler.intervalMinutes,
      playersPerRegion: config.crawler.playersPerRegion,
      regions: config.crawler.regions,
      minSampleSize: config.crawler.minSampleSize,
    },
    brawlerMeta: metaStats(),
    // Which record the meta screens are being served from. The switchover is
    // automatic, so without this there is no way to tell whether it happened.
    analyticsSource: currentSourceName(),
    summary,
    runs: runs ?? [],
    standings: standings ?? [],
    movers: movers ?? [],
    sizes: sizes ?? [],
    universe,
    tables: browsableTables(),
    counts,
    discovery: {
      perCycle: config.crawler.discoveryPerCycle,
      searchedPerCycle: config.crawler.searchedPerCycle,
      profilesPerCycle: config.crawler.profilesPerCycle,
      retentionDays: config.postgres.retentionDays,
      battleRetentionDays: config.postgres.battleRetentionDays,
    },
  };
}
