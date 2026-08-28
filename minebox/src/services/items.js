import { db, transaction } from '../db/index.js';
import { config } from '../config.js';
import { generateItemId, parseTags } from '../utils/ids.js';
import { colorFilterSql } from '../utils/color.js';
import { removeFile } from './files.js';
import { removePreview } from './previews.js';
import { FORMATS, INSTALL_HINTS, KIND_LABELS, hasFile } from '../utils/validate.js';

/** Builds the absolute URLs the mobile client consumes. */
function assetUrls(row) {
  return {
    previewUrl: `${config.publicUrl}/storage/previews/${row.preview_file}`,
    // Downloads go through the application rather than straight at the storage tree, so the
    // file arrives under the name it was uploaded with. Minecraft lists an imported pack under
    // its filename, and the name on disk is a slug plus an id fragment — accurate, unique, and
    // not what anyone wants to see in their pack list.
    fileUrl: row.file_name ? `${config.publicUrl}/d/${row.id}` : null,
  };
}

/**
 * Loads tags for a set of items in one query.
 *
 * The obvious implementation — a tag lookup per item — turns a 20-item page into 21 round
 * trips. SQLite makes each of those cheap, but the pattern stops being cheap the moment the
 * page size grows or the data moves to a networked database.
 */
function tagsFor(itemIds) {
  if (itemIds.length === 0) return new Map();

  const placeholders = itemIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT it.item_id, t.name
         FROM item_tags it
         JOIN tags t ON t.id = it.tag_id
        WHERE it.item_id IN (${placeholders})
        ORDER BY t.name`,
    )
    .all(...itemIds);

  const map = new Map(itemIds.map((id) => [id, []]));
  for (const row of rows) map.get(row.item_id)?.push(row.name);
  return map;
}

/**
 * JSON columns, read back tolerantly.
 *
 * `pack_meta` and `seed_meta` are displayed and passed on, never queried. A row written by an
 * older upload path should show what it can rather than break the only page that can look at
 * it, so an unreadable value is treated as absent.
 */
function readJson(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Wire shape for the public API — snake_case, exactly the contract the iOS app decodes.
 *
 * The kind-specific blocks are null rather than absent when they do not apply. A decoder can
 * then declare one optional property per block instead of branching on `kind` before it knows
 * which keys exist, and adding a sixth kind later cannot change the shape of the first five.
 */
export function toApiShape(row, tags) {
  const { previewUrl, fileUrl } = assetUrls(row);
  const install = row.file_ext ? FORMATS[row.file_ext]?.install : row.kind === 'seed' ? 'seed' : null;
  const pack = readJson(row.pack_meta);
  const seedMeta = readJson(row.seed_meta);

  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    category: row.category,
    description: row.description,
    edition: row.edition,
    mc_version: row.mc_version || null,

    downloads: row.downloads,
    likes: row.likes ?? 0,
    dislikes: row.dislikes ?? 0,

    preview_url: previewUrl,
    file_url: fileUrl,
    file_name: row.original_name || null,
    file_bytes: row.file_bytes || 0,

    // What the app tells the player to do with it. Sent rather than derived client-side
    // because the same extension means different things under different kinds, and keeping
    // that mapping in one place is the difference between correcting it once and shipping an
    // app update to correct it.
    install: install
      ? { method: install, hint: INSTALL_HINTS[install] || null }
      : null,

    skin: row.kind === 'skin' && row.skin_model
      ? { model: row.skin_model, width: row.skin_w, height: row.skin_h }
      : null,

    pack: pack && pack.packs?.length
      ? {
        name: pack.packs[0].name,
        version: pack.packs[0].version,
        min_engine_version: pack.packs[0].minEngineVersion,
        modules: pack.packs.flatMap((entry) => entry.modules || []),
      }
      : null,

    seed: row.kind === 'seed'
      ? { code: row.seed_code, highlights: seedMeta?.highlights || [] }
      : null,

    is_featured: Boolean(row.is_featured),
    tags: tags || [],
    color_hex: row.color_hex || null,
    created_at: row.created_at,
  };
}

/** Richer shape for admin views — includes draft state, file details and authorship. */
export function toAdminShape(row, tags) {
  const { previewUrl, fileUrl } = assetUrls(row);
  return {
    ...row,
    kindLabel: KIND_LABELS[row.kind] || row.kind,
    isFeatured: Boolean(row.is_featured),
    isPublished: Boolean(row.is_published),
    tags: tags || [],
    previewUrl,
    fileUrl,
    pack: readJson(row.pack_meta),
    seedMeta: readJson(row.seed_meta),
    install: row.file_ext ? FORMATS[row.file_ext]?.install : row.kind === 'seed' ? 'seed' : null,
  };
}

const SORT_CLAUSES = {
  // "Trending" weighs recent downloads against age so a two-year-old hit doesn't sit at the
  // top forever. Recency is measured in days, and the +2 keeps brand-new items from dividing
  // by something close to zero.
  trending: `(
      SELECT COUNT(*) FROM download_events de
       WHERE de.item_id = i.id AND de.created_at >= datetime('now', '-7 days')
    ) * 1.0 / (julianday('now') - julianday(i.created_at) + 2) DESC, i.downloads DESC`,
  newest: 'i.created_at DESC',
  oldest: 'i.created_at ASC',
  mostDownloaded: 'i.downloads DESC',
  // Net approval, not raw likes: something with 40 likes and 60 dislikes is not more liked
  // than something with 12 and none.
  mostLiked: '(i.likes - i.dislikes) DESC, i.likes DESC',
  title: 'i.title COLLATE NOCASE ASC',
  // Largest first, for finding what is eating the disk.
  biggest: 'i.file_bytes DESC',
};

/**
 * The one query behind both the public feed and the admin list.
 *
 * @param {object} options
 * @param {string|null}  options.kind        normalised singular kind
 * @param {string|null}  options.category    category within that kind
 * @param {string|null}  options.edition     'bedrock' | 'java' | 'both'
 * @param {string|null}  options.version     exact Minecraft version string
 * @param {string|null}  options.search      free text, matched against title, description and tags
 * @param {string}       options.sort        key of SORT_CLAUSES
 * @param {boolean}      options.featuredOnly
 * @param {string|null}  options.color       named colour bucket
 * @param {boolean|null} options.published   null = both (admin), true = published only (API)
 */
export function listItems({
  kind = null,
  category = null,
  edition = null,
  version = null,
  search = null,
  sort = 'trending',
  featuredOnly = false,
  color = null,
  published = true,
  page = 1,
  limit = config.defaultPageSize,
} = {}) {
  const where = [];
  const params = {};

  if (published !== null) {
    where.push('i.is_published = @published');
    params.published = published ? 1 : 0;
  }
  if (kind) {
    where.push('i.kind = @kind');
    params.kind = kind;
  }
  if (category) {
    where.push('i.category = @category');
    params.category = category;
  }
  if (edition) {
    // 'both' means the item works either way, so it belongs in the Bedrock list and the Java
    // list alike. Filtering on equality alone would hide exactly the items that are safest to
    // recommend.
    where.push("(i.edition = @edition OR i.edition = 'both')");
    params.edition = edition;
  }
  if (version) {
    where.push('i.mc_version = @version');
    params.version = version;
  }
  if (featuredOnly) {
    where.push('i.is_featured = 1');
  }
  if (color) {
    const filter = colorFilterSql(color);
    if (filter) {
      where.push(filter.sql);
      Object.assign(params, filter.params);
    }
  }
  if (search) {
    // Match the title, the description, a tag, or a seed code. `EXISTS` short-circuits on the
    // first matching tag, which beats a JOIN + DISTINCT here.
    where.push(`(
      i.title LIKE @search COLLATE NOCASE
      OR i.description LIKE @search COLLATE NOCASE
      OR i.seed_code LIKE @search COLLATE NOCASE
      OR EXISTS (
        SELECT 1 FROM item_tags it
          JOIN tags t ON t.id = it.tag_id
         WHERE it.item_id = i.id AND t.name LIKE @search COLLATE NOCASE
      )
    )`);
    params.search = `%${search}%`;
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderSql = SORT_CLAUSES[sort] || SORT_CLAUSES.trending;

  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM items i ${whereSql}`)
    .get(params);

  const offset = (page - 1) * limit;
  const rows = db
    .prepare(
      `SELECT i.*, u.username AS author
         FROM items i
    LEFT JOIN users u ON u.id = i.created_by
        ${whereSql}
     ORDER BY ${orderSql}
        LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset });

  const tags = tagsFor(rows.map((row) => row.id));

  return {
    rows,
    tags,
    total,
    page,
    limit,
    pageCount: Math.max(1, Math.ceil(total / limit)),
    hasMore: offset + rows.length < total,
  };
}

export function getItem(id, { published = null } = {}) {
  const row = db
    .prepare(
      `SELECT i.*, u.username AS author
         FROM items i
    LEFT JOIN users u ON u.id = i.created_by
        WHERE i.id = ?`,
    )
    .get(id);

  if (!row) return null;
  if (published !== null && Boolean(row.is_published) !== published) return null;

  return { row, tags: tagsFor([row.id]).get(row.id) || [] };
}

/** Replaces an item's tags, creating any that don't exist yet. */
const setTags = transaction((itemId, tagNames) => {
  db.prepare('DELETE FROM item_tags WHERE item_id = ?').run(itemId);

  const insertTag = db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
  const findTag = db.prepare('SELECT id FROM tags WHERE name = ?');
  const link = db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)');

  for (const name of tagNames) {
    insertTag.run(name);
    const tag = findTag.get(name);
    if (tag) link.run(itemId, tag.id);
  }
});

export function createItem(data) {
  const id = data.id || generateItemId();
  const tags = parseTags(data.tags);

  transaction(() => {
    db.prepare(
      `INSERT INTO items (
         id, kind, category, title, description, edition, mc_version,
         file_name, original_name, file_ext, file_bytes, preview_file,
         skin_model, skin_w, skin_h, pack_meta, seed_code, seed_meta,
         color_hue, color_sat, color_light, color_hex,
         is_featured, is_published, created_by
       ) VALUES (
         @id, @kind, @category, @title, @description, @edition, @mcVersion,
         @fileName, @originalName, @fileExt, @fileBytes, @previewFile,
         @skinModel, @skinW, @skinH, @packMeta, @seedCode, @seedMeta,
         @colorHue, @colorSat, @colorLight, @colorHex,
         @isFeatured, @isPublished, @createdBy
       )`,
    ).run({
      id,
      kind: data.kind,
      category: data.category,
      title: data.title,
      description: data.description || '',
      edition: data.edition || 'bedrock',
      mcVersion: data.mcVersion ?? null,
      fileName: data.fileName ?? null,
      originalName: data.originalName ?? null,
      fileExt: data.fileExt ?? null,
      fileBytes: data.fileBytes || 0,
      previewFile: data.previewFile,
      skinModel: data.skinModel ?? null,
      skinW: data.skinW ?? null,
      skinH: data.skinH ?? null,
      // Stored as text rather than a column per field: it is a record to read, never something
      // to query on, and its shape follows Mojang's manifest format rather than ours.
      packMeta: data.packMeta ? JSON.stringify(data.packMeta) : null,
      seedCode: data.seedCode ?? null,
      seedMeta: data.seedMeta ? JSON.stringify(data.seedMeta) : null,
      colorHue: data.color?.hue ?? null,
      colorSat: data.color?.saturation ?? null,
      colorLight: data.color?.lightness ?? null,
      colorHex: data.color?.hex ?? null,
      isFeatured: data.isFeatured ? 1 : 0,
      isPublished: data.isPublished === false ? 0 : 1,
      createdBy: data.createdBy ?? null,
    });
    setTags(id, tags);
  })();

  return id;
}

export function updateItem(id, data) {
  const fields = [];
  const params = { id };

  const assign = (column, key, value) => {
    if (value === undefined) return;
    fields.push(`${column} = @${key}`);
    params[key] = value;
  };

  assign('kind', 'kind', data.kind);
  assign('category', 'category', data.category);
  assign('title', 'title', data.title);
  assign('description', 'description', data.description);
  assign('edition', 'edition', data.edition);
  assign('mc_version', 'mcVersion', data.mcVersion);
  assign('file_name', 'fileName', data.fileName);
  assign('original_name', 'originalName', data.originalName);
  assign('file_ext', 'fileExt', data.fileExt);
  assign('file_bytes', 'fileBytes', data.fileBytes);
  assign('preview_file', 'previewFile', data.previewFile);
  assign('skin_model', 'skinModel', data.skinModel);
  assign('skin_w', 'skinW', data.skinW);
  assign('skin_h', 'skinH', data.skinH);
  assign('seed_code', 'seedCode', data.seedCode);
  assign('downloads', 'downloads', data.downloads);
  assign(
    'is_featured', 'isFeatured',
    data.isFeatured === undefined ? undefined : data.isFeatured ? 1 : 0,
  );
  assign(
    'is_published', 'isPublished',
    data.isPublished === undefined ? undefined : data.isPublished ? 1 : 0,
  );

  if (data.packMeta !== undefined) {
    assign('pack_meta', 'packMeta', data.packMeta ? JSON.stringify(data.packMeta) : null);
  }
  if (data.seedMeta !== undefined) {
    assign('seed_meta', 'seedMeta', data.seedMeta ? JSON.stringify(data.seedMeta) : null);
  }

  if (data.color !== undefined && data.color !== null) {
    assign('color_hue', 'colorHue', data.color.hue);
    assign('color_sat', 'colorSat', data.color.saturation);
    assign('color_light', 'colorLight', data.color.lightness);
    assign('color_hex', 'colorHex', data.color.hex);
  }

  transaction(() => {
    if (fields.length) {
      db.prepare(
        `UPDATE items SET ${fields.join(', ')}, updated_at = datetime('now') WHERE id = @id`,
      ).run(params);
    }
    if (data.tags !== undefined) setTags(id, parseTags(data.tags));
  })();
}

export function toggleFeatured(id) {
  const row = db.prepare('SELECT is_featured FROM items WHERE id = ?').get(id);
  if (!row) return null;

  const next = row.is_featured ? 0 : 1;
  db.prepare("UPDATE items SET is_featured = ?, updated_at = datetime('now') WHERE id = ?")
    .run(next, id);
  return Boolean(next);
}

export function togglePublished(id) {
  const row = db.prepare('SELECT is_published FROM items WHERE id = ?').get(id);
  if (!row) return null;

  const next = row.is_published ? 0 : 1;
  db.prepare("UPDATE items SET is_published = ?, updated_at = datetime('now') WHERE id = ?")
    .run(next, id);
  return Boolean(next);
}

export async function deleteItem(id) {
  const row = db.prepare('SELECT file_name, preview_file FROM items WHERE id = ?').get(id);
  if (!row) return false;

  // Remove the database row first: an orphaned file is a housekeeping chore, but a row
  // pointing at a missing file is a broken card in every client.
  db.prepare('DELETE FROM items WHERE id = ?').run(id);
  await Promise.all([removeFile(row.file_name), removePreview(row.preview_file)]);
  return true;
}

/**
 * Records how someone feels about an item, or that they no longer do.
 *
 * `value` is 1, -1, or 0 to withdraw. Changing your mind updates the row you already have
 * rather than adding another, so the totals count people rather than taps — the same reason
 * downloads are collapsed per client per day.
 *
 * The counters on `items` are recomputed from the reactions themselves inside the same
 * transaction rather than incremented. Incrementing is faster and drifts: a retry, a crash
 * between two writes, or a reaction removed by a cascading delete all leave a total nobody can
 * reconcile. Recomputing cannot disagree with the rows it is derived from.
 */
export const setReaction = transaction((id, clientKey, value) => {
  const item = db.prepare('SELECT id FROM items WHERE id = ? AND is_published = 1').get(id);
  if (!item) return null;
  if (!clientKey) return null;

  if (value === 0) {
    db.prepare('DELETE FROM reactions WHERE item_id = ? AND client_key = ?').run(id, clientKey);
  } else {
    db.prepare(
      `INSERT INTO reactions (item_id, client_key, value) VALUES (?, ?, ?)
       ON CONFLICT(item_id, client_key)
       DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    ).run(id, clientKey, value);
  }

  db.prepare(
    `UPDATE items SET
       likes    = (SELECT COUNT(*) FROM reactions WHERE item_id = ? AND value = 1),
       dislikes = (SELECT COUNT(*) FROM reactions WHERE item_id = ? AND value = -1)
     WHERE id = ?`,
  ).run(id, id, id);

  const totals = db.prepare('SELECT likes, dislikes FROM items WHERE id = ?').get(id);
  const mine = db
    .prepare('SELECT value FROM reactions WHERE item_id = ? AND client_key = ?')
    .get(id, clientKey);

  return { ...totals, yours: mine?.value ?? 0 };
});

/** What this client already said about an item, for the app to show its own state. */
export function reactionFor(id, clientKey) {
  if (!clientKey) return 0;
  const row = db
    .prepare('SELECT value FROM reactions WHERE item_id = ? AND client_key = ?')
    .get(id, clientKey);
  return row?.value ?? 0;
}

/**
 * Records a download. Returns the new total, or null if there is nothing to download.
 *
 * `clientKey` collapses repeat downloads from the same client on the same day, so the counter
 * reflects interest rather than how many times someone tapped the button.
 */
export const recordDownload = transaction((id, clientKey) => {
  const item = db
    .prepare('SELECT id, kind FROM items WHERE id = ? AND is_published = 1')
    .get(id);
  if (!item) return null;

  const day = new Date().toISOString().slice(0, 10);

  if (clientKey) {
    const seen = db
      .prepare('SELECT 1 FROM download_events WHERE item_id = ? AND day = ? AND client_key = ?')
      .get(id, day, clientKey);
    if (seen) {
      return db.prepare('SELECT downloads FROM items WHERE id = ?').get(id).downloads;
    }
  }

  db.prepare('INSERT INTO download_events (item_id, day, client_key) VALUES (?, ?, ?)')
    .run(id, day, clientKey || null);
  db.prepare('UPDATE items SET downloads = downloads + 1 WHERE id = ?').run(id);

  return db.prepare('SELECT downloads FROM items WHERE id = ?').get(id).downloads;
});

/**
 * Items most like this one.
 *
 * Ranked by shared tag count first, then by whether it is the same kind and category, then by
 * popularity. The top-up matters: an item with no tags, or with tags nobody else uses, would
 * otherwise show an empty row — so anything short of `limit` is filled with popular items of
 * the same kind.
 *
 * Same *kind* is the strong constraint rather than same category. Somebody looking at a
 * dragon addon may well want a dragon skin, but they are on the addons screen and a row of
 * skins there is a row they cannot install.
 */
export function relatedItems(id, limit = 8) {
  const source = db.prepare('SELECT id, kind, category FROM items WHERE id = ?').get(id);
  if (!source) return { rows: [], tags: new Map() };

  const rows = db
    .prepare(
      `SELECT i.*, COUNT(it.tag_id) AS shared
         FROM items i
         JOIN item_tags it ON it.item_id = i.id
        WHERE it.tag_id IN (SELECT tag_id FROM item_tags WHERE item_id = @id)
          AND i.id != @id
          AND i.kind = @kind
          AND i.is_published = 1
     GROUP BY i.id
     ORDER BY shared DESC, (i.category = @category) DESC, i.downloads DESC
        LIMIT @limit`,
    )
    .all({ id, kind: source.kind, category: source.category, limit });

  if (rows.length < limit) {
    const exclude = [id, ...rows.map((row) => row.id)];
    const placeholders = exclude.map(() => '?').join(',');
    const filler = db
      .prepare(
        `SELECT i.* FROM items i
          WHERE i.is_published = 1
            AND i.kind = ?
            AND i.id NOT IN (${placeholders})
       ORDER BY i.downloads DESC
          LIMIT ?`,
      )
      .all(source.kind, ...exclude, limit - rows.length);
    rows.push(...filler);
  }

  return { rows, tags: tagsFor(rows.map((row) => row.id)) };
}

/**
 * Records what was searched for and how much came back.
 *
 * Only page-one queries are logged: paging through results is the same intent, and counting it
 * twice would make popular searches look more popular than they are.
 */
export function logSearch({ term, kind, results }) {
  const cleaned = String(term || '').trim().toLowerCase().slice(0, 60);
  if (cleaned.length < 2) return;

  db.prepare(
    "INSERT INTO search_events (term, kind, results, day) VALUES (?, ?, ?, date('now'))",
  ).run(cleaned, kind || null, results);
}

export function allTags() {
  return db
    .prepare(
      `SELECT t.name, COUNT(it.item_id) AS uses
         FROM tags t
    LEFT JOIN item_tags it ON it.tag_id = t.id
     GROUP BY t.id
     ORDER BY uses DESC, t.name ASC`,
    )
    .all();
}

/**
 * The tab list the app builds its navigation from, with counts.
 *
 * Sent rather than hard-coded in the client so a kind with nothing in it can be hidden, and so
 * the sixth kind — whatever it turns out to be — needs no app release to appear.
 */
export function kindSummary() {
  const counts = db
    .prepare(
      `SELECT kind, COUNT(*) AS items, COALESCE(SUM(downloads), 0) AS downloads
         FROM items WHERE is_published = 1 GROUP BY kind`,
    )
    .all();

  return new Map(counts.map((row) => [row.kind, row]));
}

/** Minecraft versions actually present in the catalogue, most-used first. */
export function knownVersions(kind = null) {
  return db
    .prepare(
      `SELECT mc_version AS version, COUNT(*) AS items
         FROM items
        WHERE is_published = 1 AND mc_version IS NOT NULL
          ${kind ? 'AND kind = @kind' : ''}
     GROUP BY mc_version
     ORDER BY items DESC, mc_version DESC
        LIMIT 24`,
    )
    .all(kind ? { kind } : {});
}

/** Categories in use within a kind, with counts, for the app's filter row. */
export function categoryCounts(kind) {
  return db
    .prepare(
      `SELECT category, COUNT(*) AS items
         FROM items
        WHERE is_published = 1 AND kind = ?
     GROUP BY category
     ORDER BY items DESC`,
    )
    .all(kind);
}

export function logAudit(userId, action, subject, detail) {
  db.prepare('INSERT INTO audit_log (user_id, action, subject, detail) VALUES (?, ?, ?, ?)')
    .run(userId ?? null, action, subject ?? null, detail ?? null);
}

/** Re-exported so routes don't import the taxonomy and the store separately. */
export { hasFile };
