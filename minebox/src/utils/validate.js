/**
 * What the catalogue accepts, and what the app is told about it.
 *
 * This file is the single source of truth for the kind/category taxonomy. The database stores
 * `category` as free text on purpose — the valid set depends on `kind` and grows as the
 * catalogue does — so nothing else may write one without passing it through here first.
 */

// ── Kinds ───────────────────────────────────────────────────────────────────

export const KINDS = ['skin', 'addon', 'texture', 'world', 'seed'];

export const KIND_LABELS = {
  skin: 'Skin',
  addon: 'Addon',
  texture: 'Texture pack',
  world: 'World',
  seed: 'Seed',
};

/** Plural forms the iOS client sends in `?kind=`, mapped back to the stored singular. */
const KIND_ALIASES = {
  skin: 'skin', skins: 'skin',
  addon: 'addon', addons: 'addon', mod: 'addon', mods: 'addon', behaviour: 'addon',
  texture: 'texture', textures: 'texture', texturepack: 'texture', 'texture-pack': 'texture',
  resource: 'texture', resourcepack: 'texture', shader: 'texture', shaders: 'texture',
  world: 'world', worlds: 'world', map: 'world', maps: 'world',
  seed: 'seed', seeds: 'seed',
};

export function normaliseKind(value) {
  if (!value) return null;
  return KIND_ALIASES[String(value).trim().toLowerCase().replace(/\s+/g, '')] || null;
}

// ── Categories ──────────────────────────────────────────────────────────────
//
// Per kind, because "parkour" means nothing under skins and "capes" means nothing under
// worlds. `misc` exists in every kind so nothing ever has to be filed dishonestly to be
// filed at all.

export const CATEGORIES = {
  skin: ['boys', 'girls', 'mobs', 'anime', 'heroes', 'funny', 'pvp', 'capes', 'misc'],
  addon: ['mobs', 'weapons', 'vehicles', 'furniture', 'magic', 'tools', 'survival', 'utility', 'misc'],
  texture: ['realistic', 'pvp', 'shaders', 'ui', 'cartoon', 'medieval', 'misc'],
  world: ['survival', 'adventure', 'parkour', 'minigame', 'city', 'horror', 'redstone', 'misc'],
  seed: ['village', 'stronghold', 'biome', 'island', 'structure', 'speedrun', 'misc'],
};

export const CATEGORY_LABELS = {
  boys: 'Boys', girls: 'Girls', mobs: 'Mobs', anime: 'Anime', heroes: 'Heroes',
  funny: 'Funny', pvp: 'PvP', capes: 'Capes',
  weapons: 'Weapons', vehicles: 'Vehicles', furniture: 'Furniture', magic: 'Magic',
  tools: 'Tools', survival: 'Survival', utility: 'Utility',
  realistic: 'Realistic', shaders: 'Shaders', ui: 'UI', cartoon: 'Cartoon', medieval: 'Medieval',
  adventure: 'Adventure', parkour: 'Parkour', minigame: 'Minigame', city: 'City',
  horror: 'Horror', redstone: 'Redstone',
  village: 'Village', stronghold: 'Stronghold', biome: 'Biome', island: 'Island',
  structure: 'Structure', speedrun: 'Speedrun',
  misc: 'Other',
};

/**
 * A category, checked against the kind that has to accept it.
 *
 * Returns null rather than falling back to `misc`, because the two failures are different: a
 * filter for a category this kind doesn't have should list everything, while a *submission*
 * naming one should be refused. Only the caller knows which it is holding.
 */
export function normaliseCategory(kind, value) {
  const list = CATEGORIES[kind];
  if (!list) return null;
  const category = String(value || '').trim().toLowerCase();
  return list.includes(category) ? category : null;
}

export function categoriesFor(kind) {
  return CATEGORIES[kind] || [];
}

// ── Editions ────────────────────────────────────────────────────────────────

export const EDITIONS = ['bedrock', 'java', 'both'];

export const EDITION_LABELS = {
  bedrock: 'Bedrock',
  java: 'Java',
  both: 'Bedrock & Java',
};

export function normaliseEdition(value) {
  const edition = String(value || '').trim().toLowerCase();
  return EDITIONS.includes(edition) ? edition : null;
}

// ── Files ───────────────────────────────────────────────────────────────────

/**
 * The formats each kind accepts, and how the app is meant to install one.
 *
 * `install` is the contract with the client. It exists because the same extension means
 * different things to a user: a .mcpack under `texture` is "open it and Minecraft adds it to
 * your resource packs", while a .png under `skin` is "save it, then pick it in the skin
 * chooser" — a completely different set of instructions on a completely different screen.
 * Deriving that in the app from kind + extension would put this table in two places.
 *
 * Every .mc* format is a ZIP with a different name. `zip: true` marks the ones the uploader
 * validates by actually reading the archive, rather than by trusting what it is called.
 */
export const FORMATS = {
  '.png':       { install: 'skin_png', zip: false, mime: 'image/png' },
  '.mcpack':    { install: 'mcpack',   zip: true,  mime: 'application/octet-stream' },
  '.mcaddon':   { install: 'mcaddon',  zip: true,  mime: 'application/octet-stream' },
  '.mcworld':   { install: 'mcworld',  zip: true,  mime: 'application/octet-stream' },
  '.mctemplate':{ install: 'mcworld',  zip: true,  mime: 'application/octet-stream' },
  '.zip':       { install: 'zip',      zip: true,  mime: 'application/zip' },
};

export const ACCEPTED_EXTENSIONS = {
  skin: ['.png', '.mcpack'],
  addon: ['.mcaddon', '.mcpack', '.zip'],
  texture: ['.mcpack', '.zip'],
  world: ['.mcworld', '.mctemplate', '.zip'],
  seed: [],
};

/**
 * What the app shows under the download button.
 *
 * Written as instructions rather than as a format name, because the person reading them is
 * eleven and wants to know which button to press.
 */
export const INSTALL_HINTS = {
  skin_png: 'Save the image, then open Minecraft → Profile → Skins → Owned → Import and pick it.',
  mcpack: 'Tap Open in Minecraft. The pack lands in Settings → Global Resources.',
  mcaddon: 'Tap Open in Minecraft. It installs both halves of the addon at once.',
  mcworld: 'Tap Open in Minecraft. The world is added to your Worlds list.',
  zip: 'Unzip it, then move the folder into your Minecraft installation.',
  seed: 'Copy the code and paste it into the Seed box when you create a world.',
};

/** Per-kind upload ceilings, under multer's outer bound. */
export const MAX_BYTES = {
  // A 64x64 skin is a few kilobytes. Anything approaching a megabyte is not a skin, it is a
  // photograph somebody renamed, and it would be rejected by Minecraft after being accepted here.
  skin: 2 * 1024 * 1024,
  addon: 48 * 1024 * 1024,
  texture: 64 * 1024 * 1024,
  world: 64 * 1024 * 1024,
  seed: 0,
};

/** Whether this kind is a file at all. Seeds are a number you type into the world creator. */
export function hasFile(kind) {
  return kind !== 'seed';
}

export function extensionOf(filename) {
  const match = String(filename || '').toLowerCase().match(/\.[a-z0-9]+$/);
  return match ? match[0] : '';
}

/** Checks an upload's extension against its kind. Returns an error message, or null. */
export function checkExtension(kind, filename) {
  const allowed = ACCEPTED_EXTENSIONS[kind] || [];
  const ext = extensionOf(filename);

  if (!ext) return 'That file has no extension, so there is no way to tell what it is.';
  if (!allowed.includes(ext)) {
    return `A ${KIND_LABELS[kind].toLowerCase()} must be ${listOf(allowed)}. That file is a ${ext} file.`;
  }
  return null;
}

function listOf(extensions) {
  if (extensions.length === 1) return `a ${extensions[0]} file`;
  return `${extensions.slice(0, -1).map((e) => `a ${e}`).join(', ')} or a ${extensions.at(-1)} file`;
}

// ── Sorting ─────────────────────────────────────────────────────────────────

export const SORTS = ['trending', 'newest', 'mostDownloaded', 'mostLiked'];

export function normaliseSort(value) {
  const sort = String(value || '').trim();
  return SORTS.includes(sort) ? sort : 'trending';
}

// ── Reports ─────────────────────────────────────────────────────────────────

/**
 * Why someone reported an item.
 *
 * A fixed vocabulary rather than free text: it makes reports countable, so the panel can show
 * "nine people say this crashes on import" at a glance, and it keeps reporting to one tap. The
 * optional note carries anything the list doesn't cover.
 *
 * `version` is here because it is the single most common complaint about Bedrock content and
 * it is not a fault: a pack built for 1.20 genuinely does not load on 1.16. Filed under its own
 * reason it becomes a prompt to correct the version label, rather than nine people reporting a
 * working addon as broken.
 */
export const REPORT_REASONS = {
  broken: "Won't install or crashes",
  version: "Doesn't work on my Minecraft version",
  wrong: "Not what the description says",
  quality: 'Poor quality',
  inappropriate: 'Inappropriate content',
  copyright: 'Stolen or copyrighted',
  other: 'Something else',
};

export function normaliseReason(value) {
  const reason = String(value || '').trim().toLowerCase();
  return Object.hasOwn(REPORT_REASONS, reason) ? reason : null;
}

/** Reports that need a human to look at them urgently, surfaced first in the admin. */
export const URGENT_REASONS = new Set(['inappropriate', 'copyright']);

// ── Free text ───────────────────────────────────────────────────────────────

/** Trims, collapses whitespace and enforces a length ceiling on free-text fields. */
export function cleanText(value, maxLength) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function clampInt(value, { min, max, fallback }) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * A Minecraft version string, or null.
 *
 * Kept deliberately loose — two or three dot-separated numbers, optionally with a preview
 * suffix. Mojang ships '1.21', '1.20.80' and '1.21.0.20-beta', and a scheme strict enough to
 * reject nonsense would also reject the next thing they invent.
 */
export function normaliseVersion(value) {
  const version = String(value || '').trim().toLowerCase().replace(/^v/, '');
  if (!version) return null;
  return /^\d{1,2}(\.\d{1,3}){1,3}(-[a-z0-9.]{1,12})?$/.test(version) ? version : null;
}

/**
 * A world seed.
 *
 * Minecraft accepts any string and hashes it, so '12345', '-4172144997902289642' and
 * 'glacier' are all valid seeds and none can be rejected on syntax. The only real constraint
 * is length, because the game truncates and a seed that gets truncated is a different world.
 */
export function normaliseSeed(value) {
  const seed = String(value ?? '').trim();
  return seed.length > 0 && seed.length <= 40 ? seed : null;
}
