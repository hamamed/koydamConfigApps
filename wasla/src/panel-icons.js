import fs from 'node:fs';
import path from 'node:path';

import { config } from './config.js';

/**
 * The panel's icons.
 *
 * The game's icon pack is on the server, outside the repository (see
 * `config.iconsDir`). What is there is listed once at boot: an icon the folder
 * has is drawn as the app draws it, and anything else falls back to the Lucide
 * outline the markup already named, so the panel is never iconless.
 */
const NAME = /^[a-z0-9-]+$/;

/**
 * The icon a page wears in its heading, by the path it lives at — the same one
 * the sidebar shows beside its name, so a page and its nav entry match.
 */
const PAGE_ICONS = Object.freeze([
  ['/levels', 'grid-3x3'],
  ['/questions', 'message-circle-question'],
  ['/titles', 'tag'],
  ['/days', 'calendar-days'],
  ['/daily-games', 'list'],
  ['/daily', 'calendar-days'],
  ['/lab', 'flask-conical'],
  ['/wordsearch', 'tags'],
  ['/events', 'moon'],
  ['/import', 'file-up'],
  ['/players', 'users'],
  ['/profiles', 'user-round'],
  ['/boards', 'trophy'],
  ['/badges', 'award'],
  ['/avatars', 'smile'],
  ['/stats', 'chart-column'],
  ['/notifications', 'bell'],
  ['/settings', 'settings'],
  ['/login', 'log-in'],
]);

/** The icon for a path inside /admin; the dashboard's when nothing else fits. */
export function pageIconFor(path = '/') {
  const found = PAGE_ICONS.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));
  return found ? found[1] : 'layout-dashboard';
}

export function createPanelIcons({ dir = config.iconsDir } = {}) {
  let available = new Set();
  try {
    available = new Set(fs.readdirSync(dir)
      .filter((file) => file.endsWith('.svg'))
      .map((file) => file.slice(0, -4))
      .filter((name) => NAME.test(name)));
  } catch {
    // No folder: a fresh checkout, or a machine without the pack. Lucide it is.
  }

  /** The file for an icon name, or null when the panel does not have it. */
  function file(name) {
    return NAME.test(String(name)) && available.has(name) ? path.join(dir, `${name}.svg`) : null;
  }

  /**
   * The markup for one icon: the pack's picture when it is there, else the
   * Lucide element the page would have used.
   */
  function markup(name, size = 17) {
    const side = Number.isFinite(Number(size)) ? Number(size) : 17;
    if (!available.has(name)) {
      return `<i data-lucide="${name}" width="${side}" height="${side}"></i>`;
    }
    return `<img class="wz-i" src="/admin/icons/${name}.svg?v=${config.assetVersion}" `
      + `width="${side + 3}" height="${side + 3}" alt="" aria-hidden="true">`;
  }

  return { markup, file, count: available.size };
}
