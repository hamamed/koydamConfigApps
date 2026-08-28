/**
 * Looking inside a Minecraft archive before it goes in the catalogue.
 *
 * Two things come out of this: proof that the file will actually install, and the pack's own
 * `pack_icon.png`, which is card artwork the uploader does not have to draw.
 *
 * ## Why validate at all
 *
 * An addon that does not install is invisible from the server's side. The bytes are a
 * well-formed archive, the extension is right, the size is plausible — and Minecraft refuses
 * it silently, because there is no `manifest.json` inside or the one there has no modules. The
 * player sees nothing happen and reports the item as broken. Every check here is for a failure
 * that is certain, cheap to detect now, and impossible to diagnose later.
 *
 * The line is drawn at what Minecraft itself requires. A `.mcaddon` with no manifest is
 * refused, because the game refuses it. Anything short of that — an odd folder layout, a
 * missing icon, a version the manifest does not mention — is a warning the admin can act on,
 * because being stricter than the game would block content that works.
 */

import { looksLikeZip, readZip, findEntry, findEntries, readJsonEntry, extractEntry } from '../utils/zip.js';

/** How large an icon we are willing to lift out of an archive. */
const MAX_ICON_BYTES = 4 * 1024 * 1024;

/**
 * Module types Bedrock understands, and what each one means in plain words.
 *
 * Shown in the panel because it is the difference between an addon that changes how the game
 * behaves and one that only changes how it looks — which is the single most useful thing to
 * know about a pack, and the thing its title almost never says.
 */
const MODULE_LABELS = {
  resources: 'Resource pack',
  data: 'Behaviour pack',
  client_data: 'Client scripts',
  script: 'Scripts',
  interface: 'UI pack',
  world_template: 'World template',
  skin_pack: 'Skin pack',
};

/**
 * Reads an archive and reports what is in it.
 *
 * Throws (with `status: 400`) when the file cannot install. Returns warnings for everything
 * else, so the admin is told without being blocked.
 */
export function inspectArchive(buffer, { install }) {
  if (!looksLikeZip(buffer)) {
    throw fault(
      'That file is not an archive. Every Minecraft pack format is a ZIP underneath, so this '
      + 'is most likely an ordinary file that has been renamed.',
    );
  }

  const zip = readZip(buffer);
  const warnings = [];

  const manifests = findEntries(zip, (name) => name === 'manifest.json' || name.endsWith('/manifest.json'))
    // Deepest last, so a pack's own manifest is read before one belonging to something nested
    // inside it, and so the first entry is the outermost when both exist.
    .sort((a, b) => a.name.split('/').length - b.name.split('/').length)
    .slice(0, 8);

  const packs = manifests
    .map((entry) => describePack(readJsonEntry(buffer, entry), entry.name))
    .filter(Boolean);

  // Minecraft finds level.dat by walking the archive, so a world zipped with its folder
  // included still imports. Matching the same way avoids rejecting a file the game accepts.
  const hasLevel = Boolean(findEntry(zip, (name) => name === 'level.dat' || name.endsWith('/level.dat')));

  switch (install) {
    case 'mcpack':
    case 'mcaddon': {
      if (packs.length === 0) {
        throw fault(
          'There is no readable manifest.json inside that archive, so Minecraft will refuse to '
          + 'import it. Check that the pack folder itself was zipped rather than the folder above it.',
        );
      }
      if (packs.every((pack) => pack.modules.length === 0)) {
        throw fault(
          'The manifest inside that archive declares no modules, so Minecraft will import it and '
          + 'then do nothing with it.',
        );
      }
      break;
    }

    case 'mcworld': {
      if (!hasLevel && !packs.some((pack) => pack.isWorldTemplate)) {
        throw fault(
          'That archive has no level.dat and no world template manifest, so it is not a world '
          + 'Minecraft can import.',
        );
      }
      break;
    }

    default: {
      // A plain .zip is whatever the uploader says it is. Worth a note, not a refusal:
      // there are legitimate reasons to ship one, and no marker to check it against.
      if (packs.length === 0 && !hasLevel) {
        warnings.push(
          'That ZIP has no manifest.json and no level.dat, so it cannot be opened directly by '
          + 'Minecraft. Players will have to unpack it by hand.',
        );
      }
      break;
    }
  }

  const icon = readIcon(buffer, zip);
  if (!icon && install !== 'zip') {
    warnings.push('No pack_icon.png inside, so the card artwork has to be uploaded separately.');
  }

  return { packs, icon, warnings, entryCount: zip.entries.length, hasLevel };
}

/**
 * The parts of a Bedrock manifest worth keeping.
 *
 * Defensive throughout, because manifests are hand-edited: `version` is documented as a
 * three-number array and arrives as a string often enough that reading it as one is normal
 * rather than exceptional.
 */
function describePack(manifest, path) {
  if (!manifest || typeof manifest !== 'object') return null;

  const header = manifest.header && typeof manifest.header === 'object' ? manifest.header : {};
  const modules = Array.isArray(manifest.modules) ? manifest.modules : [];

  const types = [...new Set(modules.map((module) => String(module?.type || '')).filter(Boolean))];

  return {
    path,
    name: text(header.name, 80),
    description: text(header.description, 240),
    uuid: text(header.uuid, 40),
    version: versionString(header.version),
    minEngineVersion: versionString(header.min_engine_version),
    modules: types,
    moduleLabels: types.map((type) => MODULE_LABELS[type] || type),
    isWorldTemplate: types.includes('world_template'),
  };
}

function text(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, max);
  return trimmed || null;
}

/** `[1, 2, 0]` or `"1.2.0"` — both appear in the wild, and neither is worth failing over. */
function versionString(value) {
  if (Array.isArray(value)) {
    const parts = value.filter((part) => Number.isFinite(Number(part))).slice(0, 4);
    return parts.length ? parts.join('.') : null;
  }
  return text(value, 24);
}

/**
 * The pack's own icon, if it has one.
 *
 * `pack_icon.png` for packs, `world_icon.jpeg` for worlds — Mojang uses different names and
 * different formats for the same idea. The shallowest match wins: a `.mcaddon` holds a
 * behaviour pack and a resource pack, each with an icon, and the outer one is the addon's.
 */
function readIcon(buffer, zip) {
  const candidates = findEntries(
    zip,
    (name) => /(^|\/)(pack_icon\.png|world_icon\.(jpe?g|png))$/.test(name),
  ).sort((a, b) => a.name.split('/').length - b.name.split('/').length);

  for (const entry of candidates) {
    if (entry.size > MAX_ICON_BYTES) continue;
    try {
      const data = extractEntry(buffer, entry, MAX_ICON_BYTES);
      if (data.length > 0) return data;
    } catch {
      // A damaged icon is not a damaged pack. The upload continues without card artwork,
      // which the caller already knows how to handle.
    }
  }
  return null;
}

/** A summary line for the panel: "Behaviour pack + Resource pack · v1.2.0 · needs 1.20.0". */
export function summarise(packs) {
  if (!packs || packs.length === 0) return null;

  const labels = [...new Set(packs.flatMap((pack) => pack.moduleLabels))];
  const version = packs.find((pack) => pack.version)?.version;
  const engine = packs.find((pack) => pack.minEngineVersion)?.minEngineVersion;

  return [
    labels.join(' + ') || 'Pack',
    version ? `v${version}` : null,
    engine ? `needs ${engine}` : null,
  ].filter(Boolean).join(' · ');
}

function fault(message) {
  return Object.assign(new Error(message), { status: 400 });
}
