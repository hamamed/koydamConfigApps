import { config } from '../config.js';
import { log } from '../log.js';

/**
 * Maps and game modes, from the community catalogue.
 *
 * The official API has neither: `/events/rotation` returns a map *name* and a
 * mode string and nothing else — no artwork, no mode description, no list of
 * maps that exist outside the current rotation. Everything visual in the Maps,
 * Game Modes and Events screens comes from here.
 *
 * Verified against the live source during build: 404 active maps across 41
 * modes, every one carrying artwork at 690×1050, and 60 active game modes with
 * descriptions and brand colours.
 */

const BASE = 'https://api.brawlapi.com/v1';

/**
 * Fetches a community endpoint.
 *
 * The User-Agent is mandatory — the CDN answers 403 to clients without a
 * recognisable one, which is also why this points at `brawlapi.com` rather than
 * `brawlify.com` (the latter blocks non-browser traffic outright).
 */
async function fetchCommunity(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  try {
    const res = await fetch(`${BASE}${path}`, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'brawl-vps/1.0 (Brawl Stars companion app)',
      },
    });
    if (!res.ok) throw new Error(`community source ${path} returned ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const hexToInt = (hex) => {
  if (typeof hex !== 'string') return null;
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  return m ? `0xff${m[1].toLowerCase()}` : null;
};

/**
 * Active maps only.
 *
 * The raw list is 1,239 entries, but ~835 are retired — shipping those would
 * mean a Maps screen mostly full of maps nobody can play. `disabled` is the
 * source's own retirement flag.
 */
export async function fetchMaps() {
  const json = await fetchCommunity('/maps');
  const all = json.list ?? json.items ?? [];

  const items = all
    .filter((m) => !m.disabled && m.id)
    .map((m) => ({
      id: Number(m.id),
      name: m.name ?? 'Unknown',
      // 690×1050 portrait render — the only art in the catalogue at a size
      // worth showing full-screen.
      imageUrl: m.imageUrl ?? null,
      isNew: Boolean(m.new),
      environment: m.environment?.name ?? null,
      credit: m.credit ?? null,
      mode: {
        // `scHash` is the camelCase form the official API uses in battle logs
        // (`gemGrab`), so it's what the client's ModeInfo.parse expects.
        key: m.gameMode?.scHash ?? m.gameMode?.hash ?? m.gameMode?.name ?? null,
        name: m.gameMode?.name ?? 'Unknown',
        color: hexToInt(m.gameMode?.color),
      },
      link: m.link ?? null,
    }))
    .sort((a, b) => a.mode.name.localeCompare(b.mode.name) || a.name.localeCompare(b.name));

  log.info('Maps fetched', { total: all.length, active: items.length });
  return { count: items.length, items };
}

/** Active game modes, with the descriptions the official API doesn't provide. */
export async function fetchGameModes() {
  const json = await fetchCommunity('/gamemodes');
  const all = json.list ?? json.items ?? [];

  const items = all
    .filter((m) => !m.disabled && m.id)
    .map((m) => ({
      id: Number(m.id),
      key: m.scHash ?? m.hash ?? m.name,
      name: m.name ?? 'Unknown',
      /** e.g. "3 vs 3" — the team format. */
      subtitle: m.title ?? null,
      shortDescription: m.shortDescription ?? null,
      description: m.description ?? m.tutorial ?? null,
      color: hexToInt(m.color),
      bgColor: hexToInt(m.bgColor),
      imageUrl: m.imageUrl ?? null,
      bannerUrl: m.imageUrl2 ?? null,
      link: m.link ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  log.info('Game modes fetched', { total: all.length, active: items.length });
  return { count: items.length, items };
}

/**
 * Indexes maps by id so the events route can attach artwork.
 *
 * Map ids and event ids share a namespace (both `15xxxxxx`), so the rotation's
 * `event.id` looks the map up directly — no fuzzy name matching.
 */
export function indexMapsById(maps) {
  return new Map((maps.items ?? []).map((m) => [Number(m.id), m]));
}
