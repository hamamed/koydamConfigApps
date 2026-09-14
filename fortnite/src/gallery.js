import { clipPath } from './showcase.js';
import { resolveTier } from './tiers.js';

/**
 * The query behind the catalogue and videos galleries.
 *
 * Which cosmetics have a clip is a directory listing, not a column, so it comes
 * in as a set of ids and reaches SQLite as one JSON array read by json_each —
 * one bound parameter however many clips there are, and no string building.
 */

export const PAGE_SIZE = 48;

const VIDEO_FILTERS = new Set(['any', 'clip', 'youtube', 'none']);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const FILTER_KEYS = ['search', 'rarity', 'type', 'video'];

/** A filter value longer than this is not a name anyone typed. */
const MAX_FILTER_LENGTH = 100;

const HAS_CLIP = 'id IN (SELECT value FROM json_each(@clips))';

/**
 * Upstream fills unfinished items with the literal string "null" — as a name, a
 * type name, a set. Shown, it reads as a bug in this panel; it is treated as
 * the absence it stands for.
 */
const PLACEHOLDER = 'null';
const real = (value) => (value === PLACEHOLDER ? null : value);

const text = (value) => String(value ?? '').trim().slice(0, MAX_FILTER_LENGTH);

/**
 * The gallery filters from a query string, normalised.
 *
 * @param {Record<string, unknown>} [query]
 * @returns {{ search: string, rarity: string, type: string, video: string, page: number }}
 */
export function readFilters(query = {}) {
  const video = text(query.video);
  const page = Number.parseInt(text(query.page), 10);
  return {
    search: text(query.search).toLowerCase(),
    rarity: text(query.rarity),
    type: text(query.type),
    video: VIDEO_FILTERS.has(video) ? video : '',
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

/** An upstream showcase id, or null when the value is not one. It ends up in an embed URL. */
export function youtubeId(value) {
  return typeof value === 'string' && YOUTUBE_ID.test(value) ? value : null;
}

function whereClause(filters, clipIds) {
  const where = [];
  const params = {};

  if (filters.search) {
    where.push('search_blob LIKE @search');
    params.search = `%${filters.search}%`;
  }
  if (filters.rarity) {
    where.push('rarity = @rarity');
    params.rarity = filters.rarity;
  }
  if (filters.type) {
    where.push('type = @type');
    params.type = filters.type;
  }

  const video = {
    clip: HAS_CLIP,
    youtube: 'showcase_video IS NOT NULL',
    any: `(showcase_video IS NOT NULL OR ${HAS_CLIP})`,
    none: `(showcase_video IS NULL AND NOT ${HAS_CLIP})`,
  }[filters.video];
  if (video) {
    where.push(video);
    if (video.includes('@clips')) params.clips = JSON.stringify([...clipIds]);
  }

  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/**
 * One page of cosmetics matching the filters, newest first.
 *
 * A page past the end is clamped to the last one rather than shown empty: it
 * happens when a filter narrows the list under someone sitting on page nine.
 *
 * @param {import('better-sqlite3').Database} database
 * @param {ReturnType<typeof readFilters>} filters
 * @param {Set<string>} clipIds cosmetics that have a rendered clip
 * @param {{ pageSize?: number, clipUrl?: (id: string) => string | null }} [options]
 *   clipUrl builds a clip's link; pass the clip index's, so the link carries the
 *   same version the API sends and a replaced clip is not served from cache.
 */
export function queryGallery(database, filters, clipIds, { pageSize = PAGE_SIZE, clipUrl = clipPath } = {}) {
  const { clause, params } = whereClause(filters, clipIds);

  const total = database.prepare(`SELECT COUNT(*) AS n FROM cosmetics ${clause}`).get(params).n;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(filters.page, pages);

  const rows = database
    .prepare(
      `SELECT id, name, description, type, type_name, rarity, rarity_name, series, set_name,
              season, icon_url, featured_url, showcase_video, added_at
         FROM cosmetics ${clause}
        ORDER BY added_at IS NULL, added_at DESC, id
        LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });

  return {
    total,
    pages,
    page,
    rows: rows.map((row) => {
      const hasClip = clipIds.has(row.id);
      return {
        ...row,
        name: real(row.name) ?? row.id,
        description: real(row.description),
        type_name: real(row.type_name),
        rarity_name: real(row.rarity_name),
        series: real(row.series),
        set_name: real(row.set_name),
        // The colour the app draws it in — series first — so a card here and
        // on a phone look like the same item.
        tier: resolveTier(row.rarity, real(row.series)),
        hasClip,
        clip: hasClip ? clipUrl(row.id) : null,
        youtube: youtubeId(row.showcase_video),
      };
    }),
  };
}

/**
 * The headline numbers on the videos page.
 *
 * Coverage is counted over outfits, the only type clips are rendered for; the
 * number of cosmetics with any video counts every type, since emotes and
 * pickaxes carry YouTube showcases too.
 */
export function videoTotals(database, clipIds) {
  return database
    .prepare(
      `SELECT COALESCE(SUM(type = 'outfit'), 0) AS outfits,
              COALESCE(SUM(type = 'outfit' AND showcase_video IS NOT NULL), 0) AS youtube,
              COALESCE(SUM(type = 'outfit' AND ${HAS_CLIP}), 0) AS clips,
              COALESCE(SUM(type = 'outfit' AND showcase_video IS NULL AND NOT ${HAS_CLIP}), 0) AS missing,
              COALESCE(SUM(showcase_video IS NOT NULL OR ${HAS_CLIP}), 0) AS withVideo
         FROM cosmetics`,
    )
    .get({ clips: JSON.stringify([...clipIds]) });
}

/**
 * One option per distinct key, labelled by the display name most rows give it.
 *
 * Not MAX(name): that picks the alphabetically last, and a placeholder "null"
 * sorts after "Outfit", so every outfit was offered as "null". Counting names
 * per key in one grouped pass and choosing here costs the same scan.
 */
function optionsFor(database, keyColumn, nameColumn) {
  const groups = database
    .prepare(
      `SELECT ${keyColumn} AS key, ${nameColumn} AS name, COUNT(*) AS n
         FROM cosmetics WHERE ${keyColumn} IS NOT NULL
        GROUP BY ${keyColumn}, ${nameColumn}`,
    )
    .all();

  const byKey = new Map();
  groups.forEach(({ key, name, n }) => {
    const entry = byKey.get(key) ?? { count: 0, label: null, labelCount: 0 };
    const usable = real(name);
    const better = usable && n > entry.labelCount;
    byKey.set(key, {
      count: entry.count + n,
      label: better ? usable : entry.label,
      labelCount: better ? n : entry.labelCount,
    });
  });

  return [...byKey.entries()]
    .map(([key, entry]) => ({ [keyColumn]: key, label: entry.label ?? key, count: entry.count }))
    .sort((a, b) => b.count - a.count);
}

/** The rarities and types there are to filter by, most common first. */
export function filterOptions(database) {
  return {
    rarities: optionsFor(database, 'rarity', 'rarity_name'),
    types: optionsFor(database, 'type', 'type_name'),
  };
}

/** A link to a page of the gallery that keeps the current filters. */
export function pageHref(basePath, filters, page) {
  const params = new URLSearchParams();
  FILTER_KEYS.forEach((key) => {
    if (filters[key]) params.set(key, filters[key]);
  });
  if (page > 1) params.set('page', String(page));
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}
