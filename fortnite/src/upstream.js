import { config } from './config.js';
import { db, transaction } from './db/index.js';

/**
 * One GET against fortnite-api.com.
 *
 * No key is required for the catalogue endpoints; the header is sent only when
 * one is configured, because an empty Authorization header is worse than none —
 * some gateways reject it outright rather than ignoring it.
 */
async function get(path, { timeout = 60_000 } = {}) {
  const url = new URL(config.upstream.base + path);
  url.searchParams.set('language', config.upstream.language);

  const headers = {};
  if (config.upstream.key) headers.Authorization = config.upstream.key;

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) {
    throw new Error(`Upstream ${path} returned ${response.status}`);
  }

  const body = await response.json();
  if (body?.status && body.status !== 200) {
    throw new Error(`Upstream ${path} reported ${body.status}: ${body.error ?? 'no reason given'}`);
  }
  return body?.data;
}

function record(feed, { count = 0, error = null } = {}) {
  db.prepare(
    `INSERT INTO sync_state (feed, last_ok_at, last_try_at, last_error, item_count)
     VALUES (?, ?, datetime('now'), ?, ?)
     ON CONFLICT(feed) DO UPDATE SET
       last_ok_at  = COALESCE(excluded.last_ok_at, sync_state.last_ok_at),
       last_try_at = excluded.last_try_at,
       last_error  = excluded.last_error,
       item_count  = CASE WHEN excluded.last_error IS NULL
                          THEN excluded.item_count ELSE sync_state.item_count END`,
  ).run(feed, error ? null : new Date().toISOString(), error, count);
}

/**
 * Pulls every cosmetic and rewrites the table.
 *
 * Upsert rather than delete-then-insert: items are never removed from the
 * upstream catalogue, and a truncate would leave the API serving an empty
 * catalogue for the second or two the transaction takes.
 */
export async function syncCosmetics() {
  try {
    const items = await get('/v2/cosmetics/br');
    if (!Array.isArray(items) || !items.length) throw new Error('no cosmetics returned');

    const upsert = db.prepare(
      `INSERT INTO cosmetics (id, name, description, type, type_name, rarity, rarity_name,
                              series, set_name, introduction, season, icon_url, featured_url,
                              small_icon_url, added_at, search_blob, synced_at)
       VALUES (@id, @name, @description, @type, @type_name, @rarity, @rarity_name,
               @series, @set_name, @introduction, @season, @icon_url, @featured_url,
               @small_icon_url, @added_at, @search_blob, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, description=excluded.description, type=excluded.type,
         type_name=excluded.type_name, rarity=excluded.rarity, rarity_name=excluded.rarity_name,
         series=excluded.series, set_name=excluded.set_name, introduction=excluded.introduction,
         season=excluded.season, icon_url=excluded.icon_url, featured_url=excluded.featured_url,
         small_icon_url=excluded.small_icon_url, added_at=excluded.added_at,
         search_blob=excluded.search_blob, synced_at=datetime('now')`,
    );

    transaction((rows) => {
      for (const item of rows) upsert.run(shapeCosmetic(item));
    })(items);

    record('cosmetics', { count: items.length });
    return items.length;
  } catch (err) {
    record('cosmetics', { error: err.message });
    throw err;
  }
}

function shapeCosmetic(item) {
  const name = item.name ?? '';
  const set = item.set?.value ?? null;
  return {
    id: item.id,
    name,
    description: item.description ?? null,
    type: item.type?.value ?? null,
    type_name: item.type?.displayValue ?? null,
    rarity: item.rarity?.value ?? null,
    rarity_name: item.rarity?.displayValue ?? null,
    series: item.series?.value ?? null,
    set_name: set,
    introduction: item.introduction?.text ?? null,
    season: item.introduction?.season != null ? String(item.introduction.season) : null,
    icon_url: item.images?.icon ?? null,
    featured_url: item.images?.featured ?? null,
    small_icon_url: item.images?.smallIcon ?? null,
    added_at: item.added ?? null,
    search_blob: [name, set, item.type?.displayValue].filter(Boolean).join(' ').toLowerCase(),
  };
}

/**
 * Pulls the current item shop.
 *
 * Delete-then-insert, unlike cosmetics: the shop *is* a snapshot of what is on
 * sale right now, so an offer that stopped being sold has to disappear. Both
 * halves run in one transaction so a reader never sees an empty shop.
 */
export async function syncShop() {
  try {
    const shop = await get('/v2/shop');
    const entries = shop?.entries ?? [];
    if (!entries.length) throw new Error('no shop entries returned');

    const insert = db.prepare(
      `INSERT INTO shop_entries (offer_id, shop_date, regular_price, final_price, in_date,
                                 out_date, giftable, layout_name, tile_size, sort_priority,
                                 items_json, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    );

    transaction(() => {
      db.prepare('DELETE FROM shop_entries').run();
      for (const [index, entry] of entries.entries()) {
        const items = (entry.brItems ?? []).map((i) => ({
          id: i.id,
          name: i.name,
          type: i.type?.value ?? null,
          typeName: i.type?.displayValue ?? null,
          rarity: i.rarity?.value ?? null,
          rarityName: i.rarity?.displayValue ?? null,
          series: i.series?.value ?? null,
          icon: i.images?.icon ?? null,
          featured: i.images?.featured ?? null,
        }));

        insert.run(
          // Offer ids repeat across layouts often enough to collide, so the
          // index is folded in to keep the primary key unique within a pull.
          `${entry.offerId ?? 'offer'}:${index}`,
          shop?.date ?? new Date().toISOString(),
          entry.regularPrice ?? 0,
          entry.finalPrice ?? 0,
          entry.inDate ?? null,
          entry.outDate ?? null,
          entry.giftable ? 1 : 0,
          entry.layout?.name ?? null,
          entry.tileSize ?? null,
          entry.sortPriority ?? 0,
          JSON.stringify(items),
        );
      }
    })();

    record('shop', { count: entries.length });
    return entries.length;
  } catch (err) {
    record('shop', { error: err.message });
    throw err;
  }
}

export async function syncNews() {
  try {
    const news = await get('/v2/news/br', { timeout: 20_000 });
    const motds = news?.motds ?? [];

    const insert = db.prepare(
      `INSERT INTO news (id, title, body, tab_title, image_url, tile_url, priority, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    );

    transaction(() => {
      db.prepare('DELETE FROM news').run();
      for (const motd of motds) {
        if (motd.hidden) continue;
        insert.run(
          motd.id,
          motd.title ?? null,
          motd.body ?? null,
          motd.tabTitle ?? null,
          motd.image ?? null,
          motd.tileImage ?? null,
          motd.sortingPriority ?? 0,
        );
      }
    })();

    record('news', { count: motds.length });
    return motds.length;
  } catch (err) {
    record('news', { error: err.message });
    throw err;
  }
}

export function syncStatus() {
  return db.prepare('SELECT * FROM sync_state ORDER BY feed').all();
}
