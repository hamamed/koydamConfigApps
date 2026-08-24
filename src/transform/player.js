import { getBrawlerMeta } from './brawler_meta.js';

/**
 * Reshapes Supercell's `/players/{tag}` payload into the contract the Flutter
 * client parses in `Player.fromJson` / `PlayerBrawler.fromJson`.
 *
 * Three jobs:
 *  1. Flatten `{rarity: {name}}` / `{class: {name}}` to plain strings — the
 *     client reads `json['rarity'] as String?`, so an object would silently
 *     become `Rarity.common` for every brawler.
 *  2. Join the metadata the official API omits (rarity, class, hypercharge,
 *     portrait, gadget/star-power totals). See ./brawler_meta.js.
 *  3. Keep field names the client already expects, including Supercell's
 *     awkward `3vs3Victories`.
 */

const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export function transformPlayer(raw) {
  const brawlers = (raw.brawlers ?? []).map(transformPlayerBrawler);

  return {
    tag: raw.tag ?? '',
    name: raw.name ?? 'Unknown',
    nameColor: raw.nameColor ?? '0xffffffff',
    icon: { id: num(raw.icon?.id) },

    trophies: num(raw.trophies),
    highestTrophies: num(raw.highestTrophies),

    // Client reads `json['3vs3Victories'] ?? json['wins3v3']`; both are sent so
    // the contract survives either being renamed upstream.
    '3vs3Victories': num(raw['3vs3Victories']),
    wins3v3: num(raw['3vs3Victories']),
    soloVictories: num(raw.soloVictories),
    duoVictories: num(raw.duoVictories),

    expLevel: num(raw.expLevel),
    expPoints: num(raw.expPoints),

    club:
      raw.club && raw.club.tag
        ? {
            tag: raw.club.tag,
            name: raw.club.name ?? '',
            // Passed through when Supercell includes it. The player endpoint
            // often omits the badge even when the club has one, so the client
            // falls back to a glyph rather than assuming 0 means 'no badge'.
            badgeId: Number(raw.club.badgeId ?? 0),
          }
        : null,

    /**
     * Ranked (ex-Power League) has no public endpoint — Supercell removed it.
     * These are surfaced as null/0 and the client hides the badge accordingly.
     * If you later scrape ranked standings, populate them here and the UI lights
     * up with no client change.
     */
    rankedTier: raw.rankedTier ?? null,
    rankedRating: num(raw.rankedRating),

    brawlers,

    // Not read by the client, but useful when debugging a payload by hand.
    _meta: {
      brawlerCount: brawlers.length,
      enrichedCount: brawlers.filter((b) => b._enriched).length,
    },
  };
}

function transformPlayerBrawler(raw) {
  const meta = getBrawlerMeta(raw.id);

  const gadgetsOwned = Array.isArray(raw.gadgets) ? raw.gadgets.length : 0;
  const starPowersOwned = Array.isArray(raw.starPowers) ? raw.starPowers.length : 0;

  /**
   * Whether this player owns the hypercharge.
   *
   * The player payload has no hypercharge field at all, so it's inferred: a
   * hypercharge can only be unlocked at power 11, and only for brawlers that
   * have one. This over-reports for power-11 players who haven't bought it yet —
   * flagged here rather than hidden, because it's the one field on this object
   * that isn't ground truth.
   */
  const hasHypercharge = meta?.hasHypercharge ?? false;
  const hyperchargeUnlocked = hasHypercharge && num(raw.power) >= 11;

  return {
    id: num(raw.id),
    name: raw.name ?? meta?.name ?? 'Unknown',
    power: num(raw.power, 1),
    rank: num(raw.rank, 1),
    trophies: num(raw.trophies),
    highestTrophies: num(raw.highestTrophies),

    // Plain strings, not objects — see the module doc.
    rarity: meta?.rarity ?? 'Common',
    class: meta?.class ?? 'Damage Dealer',

    // The client derives owned counts from array LENGTH, so these must stay
    // arrays even though only the count is read.
    gadgets: raw.gadgets ?? [],
    starPowers: raw.starPowers ?? [],
    gears: raw.gears ?? [],

    // Totals come from metadata; falling back to the owned count keeps the
    // client's completion ring at 100% rather than showing "2/0".
    gadgetsTotal: meta?.gadgetsTotal ?? gadgetsOwned,
    starPowersTotal: meta?.starPowersTotal ?? starPowersOwned,

    hasHypercharge,
    hyperchargeUnlocked,

    portraitUrl: meta?.portraitUrl ?? null,

    _enriched: Boolean(meta),
  };
}

/**
 * Reshapes `/players/{tag}/battlelog`.
 *
 * Supercell's battle log is the messiest payload in the API: the shape differs
 * per mode. 3v3 modes have `battle.teams` (array of arrays) and `battle.result`;
 * showdown has `battle.players` (flat) and `battle.rank` instead of a result;
 * duo showdown has `teams` *and* `rank`. All three are normalised to one shape
 * here so the client has a single code path.
 */
export function transformBattleLog(raw, playerTag) {
  const items = raw.items ?? [];
  const normalisedTag = normaliseTag(playerTag);

  return {
    items: items.map((entry) => transformBattle(entry, normalisedTag)),
  };
}

function transformBattle(entry, playerTag) {
  const b = entry.battle ?? {};
  const isShowdown = b.rank !== undefined && b.result === undefined;

  // Flatten teams (3v3, duo) or players (solo showdown) into one list.
  const teams = Array.isArray(b.teams) ? b.teams : null;
  const flatPlayers = teams
    ? teams.flat()
    : Array.isArray(b.players)
      ? b.players
      : [];

  const me = flatPlayers.find((p) => normaliseTag(p.tag) === playerTag) ?? null;

  return {
    battleTime: entry.battleTime ?? null,

    event: {
      id: num(entry.event?.id),
      mode: entry.event?.mode ?? b.mode ?? 'unknown',
      map: entry.event?.map ?? null,
    },

    mode: b.mode ?? entry.event?.mode ?? 'unknown',
    type: b.type ?? null,

    /** `victory` | `defeat` | `draw` — derived from rank for showdown. */
    result: isShowdown ? rankToResult(b.rank) : (b.result ?? 'draw'),
    rank: b.rank ?? null,

    trophyChange: num(b.trophyChange),
    duration: b.duration ?? null,

    /** `true` when this player was the star player. */
    isStarPlayer:
      b.starPlayer && me
        ? normaliseTag(b.starPlayer.tag) === playerTag
        : false,

    starPlayer: b.starPlayer
      ? {
          tag: b.starPlayer.tag,
          name: b.starPlayer.name,
          brawler: shapeBrawlerRef(b.starPlayer.brawler),
        }
      : null,

    /** The searched player's own brawler in this match. */
    playerBrawler: me ? shapeBrawlerRef(me.brawler) : null,

    /**
     * Teams as `[[player, …], …]`. Solo showdown has no teams, so each player
     * is wrapped as a one-member team to keep the client's rendering uniform.
     */
    teams: teams
      ? teams.map((team) => team.map(shapePlayerRef))
      : flatPlayers.map((p) => [shapePlayerRef(p)]),
  };
}

function shapePlayerRef(p) {
  return {
    tag: p?.tag ?? '',
    name: p?.name ?? '',
    brawler: shapeBrawlerRef(p?.brawler),
  };
}

function shapeBrawlerRef(brawler) {
  if (!brawler) return null;
  const meta = getBrawlerMeta(brawler.id);
  return {
    id: num(brawler.id),
    name: brawler.name ?? meta?.name ?? 'Unknown',
    power: num(brawler.power),
    trophies: num(brawler.trophies),
    rarity: meta?.rarity ?? 'Common',
    class: meta?.class ?? 'Damage Dealer',
    portraitUrl: meta?.portraitUrl ?? null,
  };
}

/** Top 4 of 10 counts as a win — that's also where trophies stop being lost. */
function rankToResult(rank) {
  const r = num(rank, 99);
  if (r === 0) return 'draw';
  return r <= 4 ? 'victory' : 'defeat';
}

export function normaliseTag(raw) {
  const upper = String(raw ?? '').trim().toUpperCase();
  return upper.startsWith('#') ? upper : `#${upper}`;
}
