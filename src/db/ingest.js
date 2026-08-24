import { log } from '../log.js';
import {
  enqueueDiscovered,
  insertBattleSamples,
  recordPlayerSnapshot,
  upsertPlayer,
} from './meta_repo.js';
import {
  insertBattles,
  recordTrophyChanges,
  upsertProfile,
  upsertRoster,
} from './player_repo.js';

/**
 * Records what the API serves, as a side effect of serving it.
 *
 * Every profile someone looks up and every battle log fetched becomes durable
 * data: a trophy snapshot for that player, the battles themselves, and every
 * opponent and teammate queued for the crawler. The app's traffic becomes the
 * crawler's reach.
 *
 * ## Fire and forget
 *
 * Nothing here is awaited by a route. A response must never wait on a database
 * write it does not read back, and a slow or dead Postgres must never turn a
 * working profile request into a timeout. Failures are logged at debug and
 * dropped.
 */

/** Kicks off `work` without blocking the caller, swallowing any failure. */
function detach(name, work) {
  Promise.resolve()
    .then(work)
    .catch((err) => log.debug(`Ingest ${name} failed`, { error: err.message }));
}

/**
 * Records a searched player.
 *
 * `source: 'search'` is sticky in the upsert — once a human has looked someone
 * up, they stay marked as such, which is what puts them at the front of the
 * refresh queue.
 */
export function ingestPlayer(player) {
  if (!player?.tag) return;

  detach('player', async () => {
    await upsertPlayer(
      {
        tag: player.tag,
        name: player.name,
        trophies: player.trophies,
        highestTrophies: player.highestTrophies,
        clubTag: player.club?.tag ?? null,
        clubName: player.club?.name ?? null,
        iconId: player.icon?.id ?? null,
        expLevel: player.expLevel,
      },
      'search',
    );

    // The full profile, on top of the summary above. A searched player is one
    // of the two groups worth the extra columns — someone asked about them by
    // name, so everything the payload carries is worth keeping.
    await upsertProfile(player, 'search');

    // Their roster too. This is the only place it is free: the profile endpoint
    // returns every brawler the player owns in the same response.
    if (Array.isArray(player.brawlers) && player.brawlers.length) {
      await upsertRoster(player.tag, player.brawlers);
    }

    await recordPlayerSnapshot({
      tag: player.tag,
      trophies: player.trophies,
      highestTrophies: player.highestTrophies,
      wins3v3: player['3vs3Victories'] ?? player.wins3v3,
      winsSolo: player.soloVictories,
      winsDuo: player.duoVictories,
      brawlerCount: Array.isArray(player.brawlers) ? player.brawlers.length : null,
      expLevel: player.expLevel,
    });
  });
}

/**
 * Records a battle log and queues everyone in it.
 *
 * The queue is the point. One player's log names up to ~150 other players, and
 * each of those has a log of their own — so serving a single profile request
 * widens the crawler's frontier far more than another cycle against the same
 * top 200 ever could.
 */
export function ingestBattleLog(battles, ownerTag) {
  if (!Array.isArray(battles) || battles.length === 0) return;

  detach('battlelog', async () => {
    const samples = [];
    const discovered = new Set();

    // The per-player model, built from the same pass.
    const battleRows = [];
    const participants = [];
    const trophyDeltas = [];

    for (const battle of battles) {
      const battleTime = battle.battleTime ?? null;
      if (!battleTime) continue;

      const mode = battle.mode ?? battle.event?.mode ?? 'unknown';
      const map = battle.event?.map ?? null;
      // Same key shape the crawler uses, so a battle seen by both paths
      // deduplicates against itself rather than being stored twice.
      const battleKey = `${battleTime}|${mode}|${map ?? ''}`;
      const at = parseBattleTime(battleTime);

      const teams = Array.isArray(battle.teams) ? battle.teams : [];
      const isRanked = battle.type !== 'friendly' && battle.type !== 'challenge';
      const isShowdown = battle.rank !== null && battle.rank !== undefined;

      if (isRanked) {
        battleRows.push({
          battleKey,
          battleTime: at,
          mode,
          map,
          battleType: battle.type ?? null,
          duration: battle.duration ?? null,
          eventId: battle.event?.id ?? null,
          isShowdown,
        });

        if (typeof battle.trophyChange === 'number' && ownerTag) {
          trophyDeltas.push({
            battleKey,
            playerTag: ownerTag,
            trophyChange: battle.trophyChange,
          });
        }
      }

      const starTag = battle.starPlayer?.tag ?? null;

      teams.forEach((team, teamIndex) => {
        for (const player of team) {
          if (player?.tag) discovered.add(player.tag);

          // Friendlies are queued for discovery but never counted: they have no
          // stakes and are full of experimentation, which poisons win rates.
          if (!isRanked || !player?.brawler?.id) continue;

          // Showdown publishes no per-player outcome, so `won` stays null there
          // rather than inheriting the owner's rank.
          const won = isShowdown ? null : resultFor(battle, team, ownerTag);

          samples.push({
            battleKey,
            battleTime: at,
            mode,
            map,
            brawlerId: Number(player.brawler.id),
            brawlerName: player.brawler.name ?? '',
            won,
            teamIndex,
            brawlerTrophies: player.brawler.trophies ?? null,
            region: null,
          });

          participants.push({
            battleKey,
            playerTag: player.tag,
            playerName: player.name ?? null,
            teamIndex,
            brawlerId: Number(player.brawler.id),
            brawlerName: player.brawler.name ?? null,
            brawlerPower: player.brawler.power ?? null,
            brawlerTrophies: player.brawler.trophies ?? null,
            isStarPlayer: starTag !== null && player.tag === starTag,
            won,
            battleTime: at,
          });
        }
      });
    }

    // run_id null: these did not come from a crawl cycle. The column is
    // nullable precisely so app traffic can contribute without inventing a run.
    if (samples.length) await insertBattleSamples(null, samples);
    if (battleRows.length) await insertBattles(battleRows, participants);
    if (trophyDeltas.length) await recordTrophyChanges(trophyDeltas);
    if (discovered.size) await enqueueDiscovered([...discovered]);
  });
}

/**
 * Whether `team` won, or null when the payload does not say.
 *
 * Showdown reports a rank rather than a result, and the log only ever states
 * the outcome from the owner's point of view — so the owner's team takes the
 * stated result and the others take its inverse, exactly as the crawler does.
 */
function resultFor(battle, team, ownerTag) {
  const result = battle.result;
  if (result !== 'victory' && result !== 'defeat') return null;

  const owner = String(ownerTag ?? '').toUpperCase();
  const ownersTeam = team.some((p) => String(p.tag ?? '').toUpperCase() === owner);

  return ownersTeam ? result === 'victory' : result === 'defeat';
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
