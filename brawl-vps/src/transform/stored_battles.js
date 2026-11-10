import { getBrawlerMeta } from './brawler_meta.js';

/**
 * Stored battle rows → the same item shape as GET /player/:tag/battlelog
 * (transformBattleLog), from one player's point of view. Pure.
 *
 * What the database doesn't keep is left out honestly: showdown placement is
 * not stored, so a showdown result is `draw` with no rank; trophy changes are
 * only known when the battle came from this player's own log.
 */

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Date → Supercell's basic ISO stamp ("20261110T113304.000Z"), which the app dedupes on. */
export function apiStamp(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}.000Z`;
}

function brawlerRef(r) {
  const meta = getBrawlerMeta(r.brawler_id);
  return {
    id: Number(r.brawler_id),
    name: r.brawler_name ?? meta?.name ?? 'Unknown',
    power: Number(r.brawler_power ?? 0),
    trophies: Number(r.brawler_trophies ?? 0),
    rarity: meta?.rarity ?? 'Common',
    class: meta?.class ?? 'Damage Dealer',
    portraitUrl: meta?.portraitUrl ?? null,
  };
}

export function storedBattleItems(rows, tag) {
  const byBattle = new Map();
  for (const r of rows) {
    const list = byBattle.get(r.battle_key) ?? [];
    list.push(r);
    byBattle.set(r.battle_key, list);
  }
  const items = [];
  for (const players of byBattle.values()) {
    const first = players[0];
    const me = players.find((p) => p.player_tag === tag);
    if (!me || !first.battle_time) continue;
    const star = players.find((p) => p.is_star_player);
    const teams = new Map();
    for (const p of players) {
      const key = first.is_showdown && p.team_index == null ? p.player_tag : p.team_index ?? p.player_tag;
      const team = teams.get(key) ?? [];
      team.push({ tag: p.player_tag, name: p.player_name ?? '', brawler: brawlerRef(p) });
      teams.set(key, team);
    }
    items.push({
      battleTime: apiStamp(first.battle_time),
      event: { id: 0, mode: first.mode, map: first.map ?? null },
      mode: first.mode,
      type: first.battle_type ?? null,
      result: me.won === true ? 'victory' : me.won === false ? 'defeat' : 'draw',
      rank: null,
      trophyChange: Number(me.trophy_change ?? 0),
      duration: first.duration ?? null,
      isStarPlayer: Boolean(me.is_star_player),
      starPlayer: star ? { tag: star.player_tag, name: star.player_name ?? '', brawler: brawlerRef(star) } : null,
      playerBrawler: brawlerRef(me),
      teams: [...teams.values()],
      stored: true,
    });
  }
  return items;
}
