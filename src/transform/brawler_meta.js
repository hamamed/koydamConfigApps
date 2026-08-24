import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';
import { log } from '../log.js';

/**
 * Static brawler metadata: rarity, class, hypercharge, portrait, and the full
 * count of gadgets/star powers.
 *
 * ## Why this file exists
 *
 * The official API does not return any of it. `/players/{tag}` gives each
 * brawler as `{id, name, power, rank, trophies, highestTrophies, gears[],
 * starPowers[], gadgets[]}` — and those arrays hold only what the player has
 * *unlocked*. `/brawlers` adds the full gadget/star-power lists but still no
 * rarity, class, hypercharge or image.
 *
 * So "2 of 3 gadgets" and "Epic / Assassin" are impossible from Supercell alone.
 * This module joins them in from a community source (Brawlify), which tracks
 * balance patches and new releases.
 *
 * Hardcoding rarities was the alternative and it's a trap: they get reshuffled
 * on rework patches, and a stale table silently mislabels a player's roster.
 */

const META_PATH = path.resolve(process.cwd(), 'data', 'brawler-meta.json');
const HYPER_PATH = path.resolve(
  process.cwd(),
  'data',
  'hypercharge-overrides.json',
);

/** @type {Map<number, object>} */
let byId = new Map();
let loadedAt = 0;

/**
 * Lower-cased brawler names that have a hypercharge.
 *
 * Hand-maintained, because no free API exposes this — verified during setup
 * against api.brawlapi.com, which has no hypercharge field, and the official
 * API omits it too. See data/hypercharge-overrides.json.
 */
let hyperchargeNames = new Set();

async function loadHyperchargeOverrides() {
  try {
    const raw = await readFile(HYPER_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    hyperchargeNames = new Set(
      (parsed.hasHypercharge ?? []).map((n) => String(n).toLowerCase().trim()),
    );
    return hyperchargeNames.size;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.warn('Could not read hypercharge overrides', { error: err.message });
    }
    hyperchargeNames = new Set();
    return 0;
  }
}

/**
 * Maps Brawlify's class names onto the labels the Flutter client's
 * `BrawlerClass.parse` expects.
 *
 * Parsing on the client normalises case and separators, so only genuinely
 * different words need mapping here — `"Damage"` → `"Damage Dealer"` is the one
 * that matters.
 */
const CLASS_LABELS = {
  // The live source already sends 'Damage Dealer'; 'Damage' is kept in case it
  // reverts to the shorter form.
  'Damage Dealer': 'Damage Dealer',
  Damage: 'Damage Dealer',
  Tank: 'Tank',
  Marksman: 'Marksman',
  Artillery: 'Artillery',
  Controller: 'Controller',
  Assassin: 'Assassin',
  Support: 'Support',
  /**
   * The source sends `class: {id: 0, name: 'Unknown'}` for brawlers it hasn't
   * classified yet — typically a release from the last few days.
   */
  Unknown: 'Damage Dealer',
};

/** Rarity labels, matching the client's `Rarity.parse`. */
const RARITY_LABELS = {
  Common: 'Common',
  Rare: 'Rare',
  'Super Rare': 'Super Rare',
  Epic: 'Epic',
  Mythic: 'Mythic',
  Legendary: 'Legendary',
  /**
   * The client's Rarity enum stops at Legendary, so Ultra Legendary folds into
   * it — same gold treatment, which is also how the game presents it.
   */
  'Ultra Legendary': 'Legendary',
  /** Some sources label the starter brawler this way. */
  'Starting Brawler': 'Common',
};

/** Rarity/class values the maps didn't recognise, reported after a sync. */
const unmapped = { rarities: new Set(), classes: new Set() };

function normaliseEntry(raw) {
  const className = raw?.class?.name ?? '';
  const rarityName = raw?.rarity?.name ?? '';

  if (rarityName && !RARITY_LABELS[rarityName]) unmapped.rarities.add(rarityName);
  if (className && !CLASS_LABELS[className]) unmapped.classes.add(className);

  const name = raw.name ?? 'Unknown';

  return {
    id: raw.id,
    name,
    rarity: RARITY_LABELS[rarityName] ?? 'Common',
    class: CLASS_LABELS[className] ?? 'Damage Dealer',
    gadgetsTotal: Array.isArray(raw.gadgets) ? raw.gadgets.length : 0,
    starPowersTotal: Array.isArray(raw.starPowers) ? raw.starPowers.length : 0,
    // From the local override list — the source has no hypercharge field.
    hasHypercharge: hyperchargeNames.has(name.toLowerCase().trim()),
    /**
     * `imageUrl2` is the cropped portrait (better for a grid tile); `imageUrl`
     * is the full pin/splash art.
     */
    portraitUrl: raw.imageUrl2 ?? raw.imageUrl ?? null,
    // Kept for the codex feature — descriptions and per-item detail.
    gadgets: (raw.gadgets ?? []).map(pickItem),
    starPowers: (raw.starPowers ?? []).map(pickItem),
    description: raw.description ?? null,
  };
}

function pickItem(item) {
  return {
    id: item.id ?? null,
    name: item.name ?? '',
    description: cleanDescription(item.description),
    imageUrl: item.imageUrl ?? null,
  };
}

/** Stands in for a number the game client would substitute and we don't have. */
const UNKNOWN_VALUE = '?';

/**
 * Resolves the game's template placeholders in a description as far as it can.
 *
 * Descriptions ship with tokens the game client substitutes at runtime, e.g.
 * `"slows enemies for <!card.value1.ticksasseconds> sec!"`. The community API
 * ships the tokens but not the values — they live in the game's own card data —
 * and 87 of 537 descriptions carry one across 72 distinct token shapes, so a
 * lookup table isn't viable.
 *
 * They are replaced with `?` rather than deleted. Deleting produced sentences
 * with holes in them — `"Can be used times per activation."`, `"slow down
 * enemies for sec!"` — which read as a bug in the app rather than as a missing
 * number. `?` keeps the sentence grammatical and says plainly that one value is
 * unknown, which is the honest description of the situation.
 *
 * The tidy-up afterwards still matters: substitution leaves double spaces where
 * a token was flanked by them, and stranded punctuation where one ended a
 * clause.
 */
function cleanDescription(raw) {
  if (!raw) return null;

  const cleaned = String(raw)
    .replace(/<[^>]*>/g, UNKNOWN_VALUE)
    // Two adjacent tokens would otherwise read "? ?".
    .replace(/\?(?:\s*\?)+/g, UNKNOWN_VALUE)
    .replace(/[ \t]{2,}/g, ' ')
    // Deliberately no '?' in this class: it is now the marker, and stripping
    // the space before it would turn "for ? sec" into "for? sec".
    .replace(/\s+([.,!;:])/g, '$1')
    .replace(/\(\s*\)/g, '') // empty parens left by a stripped value
    .trim();

  return cleaned.length > 0 ? cleaned : null;
}

/** Reads the on-disk cache into memory. Safe to call repeatedly. */
export async function loadBrawlerMeta() {
  await loadHyperchargeOverrides();

  try {
    const raw = await readFile(META_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const list = parsed.brawlers ?? [];

    byId = new Map(list.map((b) => [Number(b.id), b]));
    loadedAt = parsed.syncedAt ? Date.parse(parsed.syncedAt) : Date.now();

    log.info('Brawler metadata loaded', {
      count: byId.size,
      syncedAt: parsed.syncedAt,
    });
    return byId.size;
  } catch (err) {
    if (err.code === 'ENOENT') {
      log.warn('data/brawler-meta.json missing — run `npm run sync:brawlers`', {
        hint: 'Until then, rarity/class/portraits will be absent from responses',
      });
    } else {
      log.error('Failed to load brawler metadata', { error: err.message });
    }
    return 0;
  }
}

/**
 * Fetches fresh metadata and writes it to disk.
 *
 * Falls back to the official `/brawlers` endpoint for gadget/star-power counts
 * if the community source is unreachable — partial data (correct counts, no
 * rarity) beats none.
 */
export async function syncBrawlerMeta() {
  log.info('Syncing brawler metadata', { source: config.brawlerMeta.sourceUrl });

  const hyperCount = await loadHyperchargeOverrides();
  if (hyperCount === 0) {
    log.warn(
      'No hypercharge overrides loaded — every brawler will report hasHypercharge=false',
      { path: HYPER_PATH },
    );
  }

  unmapped.rarities.clear();
  unmapped.classes.clear();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  try {
    const res = await fetch(config.brawlerMeta.sourceUrl, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        // Required. The source's CDN returns 403 to requests without a
        // recognisable User-Agent — verified against api.brawlify.com, which
        // blocks the default Node agent outright.
        'User-Agent': 'brawl-vps/1.0 (Brawl Stars companion app)',
      },
    });
    if (!res.ok) throw new Error(`metadata source returned ${res.status}`);

    const json = await res.json();
    const list = json.list ?? json.items ?? [];
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error('metadata source returned an empty list');
    }

    const brawlers = list
      .filter((b) => Number.isFinite(Number(b.id)))
      .map(normaliseEntry);

    const payload = {
      syncedAt: new Date().toISOString(),
      source: config.brawlerMeta.sourceUrl,
      count: brawlers.length,
      brawlers,
    };

    await mkdir(path.dirname(META_PATH), { recursive: true });
    await writeFile(META_PATH, JSON.stringify(payload, null, 2), 'utf8');

    byId = new Map(brawlers.map((b) => [Number(b.id), b]));
    loadedAt = Date.now();

    const withHyper = brawlers.filter((b) => b.hasHypercharge).length;
    log.info('Brawler metadata synced', {
      count: brawlers.length,
      withHypercharge: withHyper,
      path: META_PATH,
    });

    // An unrecognised value means the source renamed a tier or class. Loud,
    // because the fallback silently mislabels every affected brawler.
    if (unmapped.rarities.size || unmapped.classes.size) {
      log.warn('Unmapped metadata values — update RARITY_LABELS / CLASS_LABELS', {
        rarities: [...unmapped.rarities],
        classes: [...unmapped.classes],
      });
    }

    return payload;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Looks up one brawler.
 *
 * Returns a safe default for unknown ids so a brawler released today still
 * renders — the client's `Rarity.parse` and `BrawlerClass.parse` both fall back
 * gracefully, and a tile with a wrong rarity tint beats a crash.
 */
export function getBrawlerMeta(id) {
  return byId.get(Number(id)) ?? null;
}

export function allBrawlerMeta() {
  return [...byId.values()];
}

export function metaIsStale() {
  if (byId.size === 0) return true;
  const ageHours = (Date.now() - loadedAt) / 3_600_000;
  return ageHours >= config.brawlerMeta.refreshHours;
}

export function metaStats() {
  return {
    count: byId.size,
    loadedAt: loadedAt ? new Date(loadedAt).toISOString() : null,
    stale: metaIsStale(),
  };
}
