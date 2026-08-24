import { config } from '../config.js';
import { log } from '../log.js';
import { cacheSet } from '../cache/store.js';
import { supercell, UpstreamError } from '../supercell/client.js';
import { getBrawlerMeta } from '../transform/brawler_meta.js';
import { recordSnapshot, annotateDeltas } from './meta_history.js';
import {
  dequeueDiscovered,
  enqueueDiscovered,
  finishRun,
  insertBattleSamples,
  insertBrawlerStats,
  markCrawled,
  pruneOldSamples,
  staleSearchedPlayers,
  startRun,
  upsertDiscoveredPlayers,
  upsertPlayersSeen,
} from '../db/meta_repo.js';
import {
  enforceDiskBudget,
  insertBattles,
  pruneOldBattles,
  recordTrophyChanges,
  staleProfiles,
  upsertProfile,
  upsertRoster,
} from '../db/player_repo.js';
import { transformPlayer } from '../transform/player.js';

/**
 * Builds the live tier list by sampling top players' battle logs.
 *
 * ## Why sampling
 *
 * There is no meta endpoint. Win rates have to be computed, and the only public
 * source of match outcomes is `/players/{tag}/battlelog` — the last ~25 matches
 * for one player. So: pull the top-N players from `/rankings`, fetch each
 * battle log, and aggregate brawler outcomes per (mode, map).
 *
 * Sampling from the top of the ladder biases the result toward high-level play,
 * which is what a tier list should reflect anyway.
 *
 * ## Cost
 *
 * One request per sampled player per cycle. 200 players hourly ≈ 200 upstream
 * calls/hour, comfortably inside Supercell's limits. `CRAWLER_PLAYERS` is the
 * dial if you want a bigger sample.
 */

/**
 * Wilson score lower bound (95% confidence).
 *
 * This is the ranking metric rather than raw win rate, and it's the single most
 * important decision in this file. A brawler that went 3-0 has a 100% raw win
 * rate and would top every list; Wilson asks "given this sample size, what's
 * the lowest win rate consistent with the data?" — so 3-0 scores below 180-120.
 * Sample size earns confidence instead of being ignored.
 */
export function wilsonLowerBound(wins, total, z = 1.96) {
  if (total === 0) return 0;
  const p = wins / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return Math.max(0, (centre - margin) / denominator);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs `worker` over `items` with a bounded number of in-flight tasks. */
async function pooled(items, limit, worker) {
  const results = [];
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results.push(await worker(items[index], index));
      } catch (err) {
        // One dead player shouldn't abort the crawl — a private profile or a
        // deleted account is normal.
        log.debug('Crawler task failed', { index, error: err.message });
      }
    }
  });

  await Promise.all(runners);
  return results;
}

/** Buckets a battle by mode, and by mode+map for map-specific tier lists. */
function bucketKeys(battle) {
  const mode = battle.event?.mode ?? battle.mode ?? 'unknown';
  const map = battle.event?.map ?? null;
  const keys = [`mode:${slug(mode)}`];
  if (map) keys.push(`map:${slug(mode)}:${slug(map)}`);
  return keys;
}

const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * Collects one player's battle log into the accumulator.
 *
 * Only ranked/trophy ladder battles count — friendly matches have no stakes and
 * are full of experimentation, which poisons win rates.
 */
function ingestBattleLog(raw, acc, region, ownerTag = null) {
  for (const entry of raw.items ?? []) {
    const b = entry.battle ?? {};

    const type = b.type ?? '';
    if (type === 'friendly' || type === 'challenge') continue;

    const isShowdown = b.rank !== undefined && b.result === undefined;
    const teams = Array.isArray(b.teams) ? b.teams : null;

    const battleMeta = { event: entry.event, mode: b.mode };
    const keys = bucketKeys(battleMeta);

    // Dedupe: the same match appears in every participant's log, so without a
    // battle key the popular brawlers in a lobby get counted repeatedly.
    const battleId = `${entry.battleTime}|${b.mode}|${entry.event?.map ?? ''}`;
    if (acc.seenBattles.has(battleId)) continue;
    acc.seenBattles.add(battleId);

    // Raw rows for Postgres, captured here because this is the only place the
    // battle is still whole — downstream it has been folded into counters.
    collectSamples(acc, battleId, entry, b, isShowdown, teams, region);

    // The per-player model. Same battle, recorded a second way: `collectSamples`
    // counts brawlers and forgets who played them, which is what made every
    // per-player question unanswerable server-side.
    collectBattle(acc, battleId, entry, b, isShowdown, teams, ownerTag, region);

    // Everyone in the lobby becomes a candidate for a later cycle. This is what
    // turns a fixed top-200 sample into an expanding one: each log names up to
    // ~150 other players, and each of those has a log of their own.
    if (acc.discovered.size < MAX_DISCOVERED_PER_RUN) {
      const participants = teams ? teams.flat() : (b.players ?? []);
      for (const p of participants) {
        // Name as well as tag. A lobby is the only place a discovered player's
        // display name is free — looking it up later would cost a request per
        // player, which is the entire budget this crawler is trying to spend on
        // reaching new people.
        if (p?.tag) acc.discovered.set(p.tag, p.name ?? null);
      }
    }

    for (const key of keys) {
      const bucket = (acc.buckets[key] ??= { battles: 0, brawlers: new Map() });
      bucket.battles += 1;

      if (isShowdown) {
        const players = teams ? teams.flat() : (b.players ?? []);
        for (const p of players) {
          // Showdown has no per-player result, only the log owner's rank.
          // Attributing the owner's outcome to everyone would be wrong, so
          // showdown counts appearances only and derives win rate from the
          // owner's own row (handled below via `b.rank`).
          record(bucket, p.brawler, null);
        }
        continue;
      }

      if (!teams || teams.length < 2) continue;

      const result = b.result;
      if (result !== 'victory' && result !== 'defeat') continue;

      // `teams[0]` is always the log owner's team in Supercell's payload, so
      // team 0 takes the recorded result and team 1 takes the inverse.
      teams.forEach((team, teamIndex) => {
        const won = teamIndex === 0 ? result === 'victory' : result === 'defeat';
        for (const p of team) record(bucket, p.brawler, won);
      });
    }
  }
}

/**
 * Captures one battle as flat rows for Postgres.
 *
 * Separate from the in-memory aggregation on purpose: that path exists to
 * produce the tier list and throws the individual matches away, while these
 * rows exist so questions nobody has asked yet remain answerable later.
 *
 * Capped per crawl. A run that somehow sampled every player alive should slow
 * down, not fill a disk.
 */
function collectSamples(acc, battleKey, entry, b, isShowdown, teams, region) {
  if (acc.samples.length >= MAX_SAMPLES_PER_RUN) return;

  const mode = b.mode ?? entry.event?.mode ?? 'unknown';
  const map = entry.event?.map ?? null;
  const battleTime = parseBattleTime(entry.battleTime);

  const push = (brawler, won, teamIndex) => {
    if (!brawler?.id) return;
    acc.samples.push({
      battleKey,
      battleTime,
      mode,
      map,
      brawlerId: Number(brawler.id),
      brawlerName: brawler.name ?? '',
      won,
      teamIndex,
      // Per-brawler trophies, not the player's total. Absent on some payloads,
      // so null rather than 0 — a zero would land in the lowest bracket and
      // quietly drag its win rate around.
      brawlerTrophies:
        typeof brawler.trophies === 'number' ? brawler.trophies : null,
      region: region ?? null,
    });
  };

  if (isShowdown) {
    // Showdown reports no per-player outcome, so `won` stays null rather than
    // guessing — a null is honest, a guess would poison the aggregate later.
    // Duo keeps its team index, which is what makes duo synergy answerable
    // even though nobody's win is recorded.
    if (teams) {
      teams.forEach((team, teamIndex) => {
        for (const p of team) push(p.brawler, null, teamIndex);
      });
      return;
    }
    for (const p of b.players ?? []) push(p.brawler, null, null);
    return;
  }

  if (!teams || teams.length < 2) return;
  const result = b.result;
  if (result !== 'victory' && result !== 'defeat') return;

  teams.forEach((team, teamIndex) => {
    const won = teamIndex === 0 ? result === 'victory' : result === 'defeat';
    for (const p of team) push(p.brawler, won, teamIndex);
  });
}

/**
 * Captures one battle as a battle row plus a row per participant.
 *
 * The difference from [collectSamples] is the player tag. That one answers
 * "how does Piper do on this map"; this one answers "how does *this player* do
 * with Piper on this map", which no amount of aggregate counting can recover
 * afterwards.
 *
 * [ownerTag] is whose battle log this came from. It matters for exactly one
 * field: Supercell reports `trophyChange` only for the log's owner, so
 * attributing it to anyone else in the lobby would be a fabrication.
 */
function collectBattle(
  acc, battleKey, entry, b, isShowdown, teams, ownerTag, region,
) {
  if (acc.battles.length >= MAX_BATTLES_PER_RUN) return;

  const battleTime = parseBattleTime(entry.battleTime);
  const mode = b.mode ?? entry.event?.mode ?? 'unknown';

  acc.battles.push({
    battleKey,
    battleTime,
    mode,
    map: entry.event?.map ?? null,
    battleType: b.type ?? null,
    duration: typeof b.duration === 'number' ? b.duration : null,
    eventId: entry.event?.id ? Number(entry.event.id) : null,
    isShowdown,
  });

  const starTag = b.starPlayer?.tag ?? null;

  const push = (p, teamIndex, won) => {
    if (!p?.tag || !p.brawler?.id) return;
    acc.participants.push({
      battleKey,
      playerTag: p.tag,
      playerName: p.name ?? null,
      teamIndex,
      brawlerId: Number(p.brawler.id),
      brawlerName: p.brawler.name ?? null,
      brawlerPower: typeof p.brawler.power === 'number' ? p.brawler.power : null,
      brawlerTrophies:
        typeof p.brawler.trophies === 'number' ? p.brawler.trophies : null,
      isStarPlayer: starTag !== null && p.tag === starTag,
      won,
      battleTime,
      region: region ?? null,
    });
  };

  if (isShowdown) {
    // No per-player result is published, so `won` stays null. Duo keeps its
    // team index, which is what makes duo partnerships answerable even though
    // nobody's win is recorded.
    if (teams) {
      teams.forEach((team, teamIndex) => {
        for (const p of team) push(p, teamIndex, null);
      });
    } else {
      for (const p of b.players ?? []) push(p, null, null);
    }
  } else if (teams && teams.length >= 2) {
    const result = b.result;
    if (result === 'victory' || result === 'defeat') {
      teams.forEach((team, teamIndex) => {
        const won = teamIndex === 0 ? result === 'victory' : result === 'defeat';
        for (const p of team) push(p, teamIndex, won);
      });
    }
  }

  if (ownerTag && typeof b.trophyChange === 'number') {
    acc.trophyDeltas.push({
      battleKey,
      playerTag: ownerTag,
      trophyChange: b.trophyChange,
    });
  }
}

/** Supercell sends `20260727T162756.000Z`, which `Date` refuses to parse. */
function parseBattleTime(raw) {
  if (typeof raw !== 'string' || raw.length < 15) return null;
  const iso =
    `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 11)}` +
    `:${raw.slice(11, 13)}:${raw.slice(13)}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Ceiling on raw rows kept from a single crawl. */
const MAX_SAMPLES_PER_RUN = 200_000;

/**
 * Ceiling on battles recorded per crawl.
 *
 * Each carries up to six participant rows, so this is really a cap of ~240k
 * rows. A cycle that somehow reached every player alive should slow down rather
 * than fill a disk.
 */
const MAX_BATTLES_PER_RUN = 40_000;

/**
 * Ceiling on tags queued from a single crawl.
 *
 * Each cycle can only drain a bounded number of them anyway, so an unbounded
 * queue would just grow forever and hand out increasingly stale tags.
 */
const MAX_DISCOVERED_PER_RUN = 20_000;

function record(bucket, brawler, won) {
  if (!brawler?.id) return;
  const id = Number(brawler.id);

  const entry = bucket.brawlers.get(id) ?? {
    id,
    name: brawler.name ?? '',
    appearances: 0,
    wins: 0,
    decided: 0,
  };

  entry.appearances += 1;
  if (won !== null) {
    entry.decided += 1;
    if (won) entry.wins += 1;
  }

  bucket.brawlers.set(id, entry);
}

/** Turns raw counts into the ranked payload the client renders. */
function finaliseBucket(key, bucket) {
  const rows = [];

  for (const entry of bucket.brawlers.values()) {
    if (entry.appearances < config.crawler.minSampleSize) continue;

    const meta = getBrawlerMeta(entry.id);
    const winRate = entry.decided > 0 ? entry.wins / entry.decided : null;

    rows.push({
      id: entry.id,
      name: meta?.name ?? entry.name,
      rarity: meta?.rarity ?? 'Common',
      class: meta?.class ?? 'Damage Dealer',
      portraitUrl: meta?.portraitUrl ?? null,

      appearances: entry.appearances,
      /** Share of battles in this bucket featuring the brawler. */
      pickRate: bucket.battles > 0 ? entry.appearances / bucket.battles : 0,
      winRate,
      /** Ranking metric — see wilsonLowerBound. */
      score: winRate === null ? 0 : wilsonLowerBound(entry.wins, entry.decided),
      /**
       * Decided battles behind `winRate`.
       *
       * `wins` is carried alongside it so the stored row can be re-aggregated.
       * A rate alone cannot be summed across buckets — averaging per-mode
       * percentages weights a 40-battle bucket the same as a 4,000-battle one —
       * and every history query pools modes, so it needs the raw numerator and
       * denominator rather than the ratio.
       */
      wins: entry.wins,
      sampleSize: entry.decided,
    });
  }

  rows.sort((a, b) => b.score - a.score || b.appearances - a.appearances);

  // Letter tiers by position, which keeps the bands stable as win rates drift.
  const total = rows.length;
  rows.forEach((row, i) => {
    const pct = total <= 1 ? 0 : i / (total - 1);
    row.tier =
      pct <= 0.1 ? 'S' : pct <= 0.3 ? 'A' : pct <= 0.55 ? 'B' : pct <= 0.8 ? 'C' : 'D';
    row.rank = i + 1;
  });

  return {
    key,
    battles: bucket.battles,
    brawlers: rows,
  };
}

/** Runs one full crawl cycle and writes the results to cache. */
export async function runCrawl() {
  const startedAt = Date.now();
  log.info('Meta crawl starting', {
    regions: config.crawler.regions,
    playersPerRegion: config.crawler.playersPerRegion,
  });

  const acc = {
    buckets: {},
    seenBattles: new Set(),
    samples: [],
    // Every player met in a log this cycle, tag -> display name. Becomes next
    // cycle's frontier. A Map rather than a Set so the name travels with the
    // tag into players_seen.
    discovered: new Map(),

    // The per-player model, accumulated alongside the aggregate one.
    battles: [],
    participants: [],
    trophyDeltas: [],
  };
  let tagsCollected = 0;
  const sampledPlayers = [];

  // Opened before any work so a crash mid-crawl still leaves a 'running' row —
  // a run that vanished entirely is indistinguishable from one that never
  // started, and the panel should be able to tell those apart.
  const runId = await startRun();

  for (const region of config.crawler.regions) {
    let tags = [];
    try {
      const rankings = await supercell.rankingsPlayers(
        region.trim(),
        config.crawler.playersPerRegion,
      );
      tags = (rankings.items ?? []).map((p) => p.tag).filter(Boolean);
      for (const p of rankings.items ?? []) {
        if (p.tag) {
          sampledPlayers.push({
            tag: p.tag,
            name: p.name,
            trophies: p.trophies,
            region: region.trim(),
          });
        }
      }
    } catch (err) {
      log.warn('Failed to fetch rankings for region', {
        region,
        error: err.message,
      });
      continue;
    }

    tagsCollected += tags.length;

    await pooled(tags, config.crawler.concurrency, async (tag) => {
      try {
        const battleLog = await supercell.battleLog(tag);
        ingestBattleLog(battleLog, acc, region.trim(), tag);
      } catch (err) {
        // 404 is normal — top-ladder accounts get renamed and deleted.
        if (!(err instanceof UpstreamError && err.status === 404)) throw err;
      }
      // A small spacer keeps the burst well under the upstream rate limit.
      await sleep(40);
    });
  }

  // ── Expansion ─────────────────────────────────────────────────────────────
  //
  // The rankings give the same top 200 every cycle, and those players do not
  // play 25 fresh matches an hour — the second crawl after a deploy added only
  // 567 new battles against the first one's 30,000. Growth has to come from
  // widening the frontier, not from asking the same people again.
  //
  // Two extra sources, both bounded so a cycle's upstream cost stays
  // predictable:
  //   * players discovered in the battle logs already fetched, and in logs the
  //     API served to the app
  //   * players a human searched, refreshed on their own cadence
  const extraTags = [];

  if (config.crawler.discoveryPerCycle > 0) {
    const [discovered, searched] = await Promise.all([
      dequeueDiscovered(config.crawler.discoveryPerCycle),
      staleSearchedPlayers(config.crawler.searchedPerCycle),
    ]);

    // Deduplicated against the ranking sample: a top-200 player who also turns
    // up in the queue must not cost two requests in one cycle.
    const already = new Set(sampledPlayers.map((p) => p.tag));
    for (const tag of [...(searched ?? []), ...(discovered ?? [])]) {
      if (tag && !already.has(tag)) {
        already.add(tag);
        extraTags.push(tag);
      }
    }

    // Said out loud every cycle, including when it is zero.
    //
    // Silence here is indistinguishable from a crawler that never had the
    // feature: an empty queue on the first run after a deploy looks exactly
    // like a broken one, and both look like "it only crawls the top 200".
    log.info('Discovery batch', {
      fromQueue: discovered?.length ?? 0,
      fromSearches: searched?.length ?? 0,
      afterDedupe: extraTags.length,
      queueLimit: config.crawler.discoveryPerCycle,
    });
  } else {
    log.info('Discovery disabled', { reason: 'CRAWLER_DISCOVERY=0' });
  }

  if (extraTags.length) {
    log.info('Crawling discovered players', { count: extraTags.length });

    await pooled(extraTags, config.crawler.concurrency, async (tag) => {
      try {
        const battleLog = await supercell.battleLog(tag);
        // No region: a queued tag was met in someone's lobby, and where we
        // found them says nothing about where they play.
        ingestBattleLog(battleLog, acc, null, tag);
      } catch (err) {
        if (!(err instanceof UpstreamError && err.status === 404)) throw err;
      }
      await sleep(40);
    });

    tagsCollected += extraTags.length;
    await markCrawled(extraTags);
  }

  // ── Profile refresh ───────────────────────────────────────────────────────
  //
  // A battle log says what someone played; only the player endpoint says who
  // they are — trophies, roster, club. That is a second request per player, so
  // it is spent on the two groups worth it: the ranked 200 and anyone a human
  // searched. Discovered players stay tag-and-name until somebody asks.
  //
  // Rotated a few dozen at a time rather than refreshed wholesale, which keeps
  // the per-cycle cost flat regardless of how large the known population gets.
  if (config.crawler.profilesPerCycle > 0) {
    const stale = await staleProfiles(config.crawler.profilesPerCycle);

    if (stale.length) {
      let refreshed = 0;

      await pooled(stale, config.crawler.concurrency, async (tag) => {
        try {
          const raw = await supercell.player(tag);
          const player = transformPlayer(raw);

          await upsertProfile(player, null);
          if (player.brawlers?.length) {
            await upsertRoster(player.tag, player.brawlers);
          }
          refreshed += 1;
        } catch (err) {
          // 404 is normal — top-ladder accounts get renamed and deleted.
          if (!(err instanceof UpstreamError && err.status === 404)) throw err;
        }
        await sleep(40);
      });

      log.info('Refreshed player profiles', {
        attempted: stale.length,
        refreshed,
      });
    }
  }

  // Everyone seen in this cycle's logs goes back into the queue, so the next
  // cycle reaches one hop further out.
  if (acc.discovered.size) {
    // Record them as well as queue them. Without this the queue drains, their
    // battle logs are crawled, and players_seen never hears about it — which is
    // exactly what happened: 27,000 tags queued, 813,000 samples collected, and
    // a "player universe" still reading 199 ranked players and 0 discovered.
    //
    // markCrawled() also depends on the row existing, so before this its UPDATE
    // matched nothing and every discovered player looked permanently un-crawled.
    const recorded = await upsertDiscoveredPlayers(
      [...acc.discovered].map(([tag, name]) => ({ tag, name })),
    );

    const queued = await enqueueDiscovered([...acc.discovered.keys()]);

    // Info, not debug. This is the number that says whether the snowball is
    // turning at all, and at the default log level a debug line is invisible —
    // so the one signal that would have explained a stalled frontier was the
    // one nobody could see.
    //
    // `queued` coming back 0 while `seen` is in the thousands means the insert
    // failed: the pool logs the error and returns null rather than throwing,
    // so this is the only place that shows up.
    log.info('Queued discovered players', {
      seen: acc.discovered.size,
      queued,
      recorded,
    });
  } else {
    log.warn('No players discovered this cycle', {
      hint: 'Battle logs yielded no participant tags — the frontier cannot grow.',
    });
  }

  const buckets = Object.entries(acc.buckets).map(([key, bucket]) =>
    finaliseBucket(key, bucket),
  );

  const modes = buckets.filter((b) => b.key.startsWith('mode:'));
  const maps = buckets.filter((b) => b.key.startsWith('map:'));

  const payload = {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    sample: {
      playersSampled: tagsCollected,
      battlesAnalysed: acc.seenBattles.size,
      minSampleSize: config.crawler.minSampleSize,
    },
    modes: Object.fromEntries(modes.map((b) => [b.key.slice(5), b])),
    maps: Object.fromEntries(maps.map((b) => [b.key.slice(4), b])),
  };

  // Record before annotating: the snapshot stores this crawl's own numbers,
  // and returns the prior one to diff against.
  const previous = await recordSnapshot(payload);
  annotateDeltas(payload, previous);

  // TTL is 3× the crawl interval so a couple of failed cycles don't leave the
  // endpoint empty.
  await cacheSet('meta:tierlist', payload, config.crawler.intervalMinutes * 60 * 3);

  // Persistence is best-effort and last. The tier list is already cached and
  // servable by this point, so a database that is down, full or slow delays
  // nothing the client is waiting on.
  const persisted = await persist(runId, {
    payload,
    samples: acc.samples,
    players: sampledPlayers,
    buckets: modes.length + maps.length,
    battles: acc.battles,
    participants: acc.participants,
    trophyDeltas: acc.trophyDeltas,
  });

  log.info('Meta crawl complete', {
    players: tagsCollected,
    battles: acc.seenBattles.size,
    modes: modes.length,
    maps: maps.length,
    durationMs: payload.durationMs,
    ...persisted,
  });

  return payload;
}

/**
 * Writes a finished crawl to Postgres.
 *
 * Never throws: every failure is logged and swallowed. This service answered
 * every request it answers today before a database existed, and it must keep
 * doing so if one goes away.
 */
async function persist(runId, {
  payload,
  samples,
  players,
  buckets,
  battles = [],
  participants = [],
  trophyDeltas = [],
}) {
  if (!runId) return { persisted: false };

  try {
    const rows = [];

    const collect = (bucketKind, bucketMap, splitKey) => {
      for (const [key, bucket] of Object.entries(bucketMap)) {
        // Map buckets are keyed `mode:map-slug`; mode buckets are just the mode.
        const [mode, map] = splitKey(key);
        for (const b of bucket.brawlers ?? []) {
          rows.push({
            bucketKind,
            mode,
            map,
            brawlerId: b.id,
            brawlerName: b.name,
            appearances: b.appearances,
            wins: b.wins ?? 0,
            // The payload calls this `sampleSize`; the column is `decided`.
            // They are the same number — decided battles — and reading the
            // wrong name here silently stored zeroes, which left every
            // aggregate query returning nothing while the win rates looked fine.
            decided: b.sampleSize ?? 0,
            winRate: b.winRate,
            score: b.score,
            tier: b.tier,
            rank: b.rank,
          });
        }
      }
    };

    collect('mode', payload.modes, (key) => [key, null]);
    collect('map', payload.maps, (key) => {
      const parts = key.split(':');
      return [parts[0], parts.slice(1).join(':') || null];
    });

    const [sampleCount, statCount] = await Promise.all([
      // Skipped once the operator has confirmed the per-player model and turned
      // WRITE_LEGACY_SAMPLES off — at that point this is a second copy of every
      // battle, written only to keep a fallback alive that is no longer used.
      config.analytics.writeLegacySamples
        ? insertBattleSamples(runId, samples)
        : Promise.resolve(0),
      insertBrawlerStats(runId, rows),
      upsertPlayersSeen(players),
    ]);

    // Sequential, and after the aggregates. `battle_players` has a foreign key
    // onto `battles`, so the two cannot race — and if the database is going to
    // struggle with anything in this function it is this, the largest write.
    const battleCounts = await insertBattles(battles, participants);
    const deltas = await recordTrophyChanges(trophyDeltas);

    await finishRun(runId, {
      playersSampled: payload.sample.playersSampled,
      battlesAnalysed: payload.sample.battlesAnalysed,
      buckets,
      durationMs: payload.durationMs,
    });

    // Housekeeping rides along with the crawl rather than needing its own
    // schedule — the crawler is already the only thing that runs on a timer.
    //
    // Two windows, deliberately different: the legacy sample table keeps its
    // 45 days, while the per-player battles keep the six months they were asked
    // for. The disk guard then overrides both if the tables outgrow their
    // budget, because a Postgres that fills its disk stops accepting writes.
    await pruneOldSamples(config.postgres.retentionDays);
    await pruneOldBattles(config.postgres.battleRetentionDays);
    await enforceDiskBudget(
      config.postgres.diskBudgetBytes,
      config.postgres.battleRetentionDays,
    );

    return {
      persisted: true,
      newSamples: sampleCount,
      statRows: statCount,
      newBattles: battleCounts.battles,
      newParticipants: battleCounts.participants,
      trophyDeltas: deltas,
    };
  } catch (err) {
    log.error('Failed to persist crawl', { error: err.message });
    await finishRun(runId, { error: err.message }).catch(() => {});
    return { persisted: false };
  }
}
