import { db, transaction } from '../db/index.js';
import { config } from '../config.js';
import { generateSkinId, parseTags } from '../utils/ids.js';
import { removeAssets } from './images.js';
import { colorFilterSql } from '../utils/color.js';

/** Builds the absolute URLs the mobile client consumes. */
function assetUrls(row) {
  return {
    previewUrl: `${config.publicUrl}/storage/previews/${row.preview_file}`,
    templateUrl: `${config.publicUrl}/storage/templates/${row.template_file}`,
  };
}

/**
 * Loads tags for a set of skins in one query.
 *
 * The obvious implementation — a tag lookup per skin — turns a 20-item page into 21 round trips.
 * SQLite makes each of those cheap, but the pattern stops being cheap the moment the page size
 * grows or the data moves to a networked database.
 */
function tagsFor(skinIds) {
  if (skinIds.length === 0) return new Map();

  const placeholders = skinIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT st.skin_id, t.name
         FROM skin_tags st
         JOIN tags t ON t.id = st.tag_id
        WHERE st.skin_id IN (${placeholders})
        ORDER BY t.name`
    )
    .all(...skinIds);

  const map = new Map(skinIds.map((id) => [id, []]));
  for (const row of rows) map.get(row.skin_id)?.push(row.name);
  return map;
}

/** Wire shape for the public API — snake_case, exactly the contract the iOS app decodes. */
export function toApiShape(row, tags) {
  const { previewUrl, templateUrl } = assetUrls(row);
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    downloads: row.downloads,
    likes: row.likes ?? 0,
    dislikes: row.dislikes ?? 0,
    preview_url: previewUrl,
    template_url: templateUrl,
    is_featured: Boolean(row.is_featured),
    tags: tags || [],
    color_hex: row.color_hex || null,
  };
}

/** Richer shape for admin views — includes unpublished state, file info and authorship. */
export function toAdminShape(row, tags) {
  const { previewUrl, templateUrl } = assetUrls(row);
  return {
    ...row,
    isFeatured: Boolean(row.is_featured),
    isPublished: Boolean(row.is_published),
    tags: tags || [],
    previewUrl,
    templateUrl,
  };
}

const SORT_CLAUSES = {
  // "Trending" weighs recent downloads against age so a three-year-old hit doesn't sit at the
  // top forever. Recency is measured in days, and the +2 keeps brand-new items from dividing
  // by something close to zero.
  trending: `(
      SELECT COUNT(*) FROM download_events de
       WHERE de.skin_id = s.id AND de.created_at >= datetime('now', '-7 days')
    ) * 1.0 / (julianday('now') - julianday(s.created_at) + 2) DESC, s.downloads DESC`,
  newest: 's.created_at DESC',
  mostDownloaded: 's.downloads DESC',
  // Net approval, not raw likes: something with 40 likes and 60 dislikes is not
  // more liked than something with 12 and none.
  mostLiked: '(s.likes - s.dislikes) DESC, s.likes DESC',
  title: 's.title COLLATE NOCASE ASC',
  oldest: 's.created_at ASC',
};

/**
 * The one query behind both the public feed and the admin list.
 *
 * @param {object} options
 * @param {string|null} options.category   normalised singular category
 * @param {string|null} options.search     free text, matched against title and tags
 * @param {string}      options.sort       key of SORT_CLAUSES
 * @param {boolean}     options.featuredOnly
 * @param {string|null} options.color      named colour bucket
 * @param {boolean|null} options.published  null = both (admin), true = published only (API)
 */
export function listSkins({
  category = null,
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
    where.push('s.is_published = @published');
    params.published = published ? 1 : 0;
  }
  if (category) {
    where.push('s.category = @category');
    params.category = category;
  }
  if (featuredOnly) {
    where.push('s.is_featured = 1');
  }
  if (color) {
    const filter = colorFilterSql(color);
    if (filter) {
      where.push(filter.sql);
      Object.assign(params, filter.params);
    }
  }
  if (search) {
    // Match the title or any tag. `EXISTS` short-circuits on the first matching tag, which
    // beats a JOIN + DISTINCT here.
    where.push(`(
      s.title LIKE @search COLLATE NOCASE
      OR s.description LIKE @search COLLATE NOCASE
      OR EXISTS (
        SELECT 1 FROM skin_tags st
          JOIN tags t ON t.id = st.tag_id
         WHERE st.skin_id = s.id AND t.name LIKE @search COLLATE NOCASE
      )
    )`);
    params.search = `%${search}%`;
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderSql = SORT_CLAUSES[sort] || SORT_CLAUSES.trending;

  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM skins s ${whereSql}`)
    .get(params);

  const offset = (page - 1) * limit;
  const rows = db
    .prepare(
      `SELECT s.*, u.username AS author
         FROM skins s
    LEFT JOIN users u ON u.id = s.created_by
        ${whereSql}
     ORDER BY ${orderSql}
        LIMIT @limit OFFSET @offset`
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

export function getSkin(id, { published = null } = {}) {
  const row = db
    .prepare(
      `SELECT s.*, u.username AS author
         FROM skins s
    LEFT JOIN users u ON u.id = s.created_by
        WHERE s.id = ?`
    )
    .get(id);

  if (!row) return null;
  if (published !== null && Boolean(row.is_published) !== published) return null;

  return { row, tags: tagsFor([row.id]).get(row.id) || [] };
}

/** Replaces a skin's tags, creating any that don't exist yet. */
const setTags = transaction((skinId, tagNames) => {
  db.prepare('DELETE FROM skin_tags WHERE skin_id = ?').run(skinId);

  const insertTag = db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
  const findTag = db.prepare('SELECT id FROM tags WHERE name = ?');
  const link = db.prepare('INSERT OR IGNORE INTO skin_tags (skin_id, tag_id) VALUES (?, ?)');

  for (const name of tagNames) {
    insertTag.run(name);
    const tag = findTag.get(name);
    if (tag) link.run(skinId, tag.id);
  }
});

export function createSkin(data) {
  const id = data.id || generateSkinId();
  const tags = parseTags(data.tags);

  transaction(() => {
    db.prepare(
      `INSERT INTO skins (
         id, title, category, description, template_file, preview_file,
         template_w, template_h, file_bytes, is_featured, is_published, created_by,
         color_hue, color_sat, color_light, color_hex, design_meta
       ) VALUES (
         @id, @title, @category, @description, @templateFile, @previewFile,
         @templateW, @templateH, @fileBytes, @isFeatured, @isPublished, @createdBy,
         @colorHue, @colorSat, @colorLight, @colorHex, @designMeta
       )`
    ).run({
      id,
      title: data.title,
      category: data.category,
      description: data.description || '',
      templateFile: data.templateFile,
      previewFile: data.previewFile,
      templateW: data.templateW ?? null,
      templateH: data.templateH ?? null,
      fileBytes: data.fileBytes || 0,
      isFeatured: data.isFeatured ? 1 : 0,
      isPublished: data.isPublished === false ? 0 : 1,
      createdBy: data.createdBy ?? null,
      colorHue: data.color?.hue ?? null,
      colorSat: data.color?.saturation ?? null,
      colorLight: data.color?.lightness ?? null,
      colorHex: data.color?.hex ?? null,
      // Stored as text rather than a column per field: it is a record to read,
      // never something to query on, and its shape will change as the planner does.
      designMeta: data.designMeta ? JSON.stringify(data.designMeta) : null,
    });
    setTags(id, tags);
  })();

  return id;
}

export function updateSkin(id, data) {
  const fields = [];
  const params = { id };

  const assign = (column, key, value) => {
    if (value === undefined) return;
    fields.push(`${column} = @${key}`);
    params[key] = value;
  };

  assign('title', 'title', data.title);
  assign('category', 'category', data.category);
  assign('description', 'description', data.description);
  assign('template_file', 'templateFile', data.templateFile);
  assign('preview_file', 'previewFile', data.previewFile);
  assign('template_w', 'templateW', data.templateW);
  assign('template_h', 'templateH', data.templateH);
  assign('file_bytes', 'fileBytes', data.fileBytes);
  assign('is_featured', 'isFeatured', data.isFeatured === undefined ? undefined : data.isFeatured ? 1 : 0);
  assign('is_published', 'isPublished', data.isPublished === undefined ? undefined : data.isPublished ? 1 : 0);
  assign('downloads', 'downloads', data.downloads);

  if (data.color !== undefined && data.color !== null) {
    assign('color_hue', 'colorHue', data.color.hue);
    assign('color_sat', 'colorSat', data.color.saturation);
    assign('color_light', 'colorLight', data.color.lightness);
    assign('color_hex', 'colorHex', data.color.hex);
  }

  transaction(() => {
    if (fields.length) {
      db.prepare(
        `UPDATE skins SET ${fields.join(', ')}, updated_at = datetime('now') WHERE id = @id`
      ).run(params);
    }
    if (data.tags !== undefined) setTags(id, parseTags(data.tags));
  })();
}

export function toggleFeatured(id) {
  const row = db.prepare('SELECT is_featured FROM skins WHERE id = ?').get(id);
  if (!row) return null;

  const next = row.is_featured ? 0 : 1;
  db.prepare("UPDATE skins SET is_featured = ?, updated_at = datetime('now') WHERE id = ?")
    .run(next, id);
  return Boolean(next);
}

export function togglePublished(id) {
  const row = db.prepare('SELECT is_published FROM skins WHERE id = ?').get(id);
  if (!row) return null;

  const next = row.is_published ? 0 : 1;
  db.prepare("UPDATE skins SET is_published = ?, updated_at = datetime('now') WHERE id = ?")
    .run(next, id);
  return Boolean(next);
}

export async function deleteSkin(id) {
  const row = db.prepare('SELECT template_file, preview_file FROM skins WHERE id = ?').get(id);
  if (!row) return false;

  // Remove the database row first: an orphaned file is a housekeeping chore, but a row pointing
  // at a missing file is a broken card in every client.
  db.prepare('DELETE FROM skins WHERE id = ?').run(id);
  await removeAssets({ templateFile: row.template_file, previewFile: row.preview_file });
  return true;
}

/**
 * Records how someone feels about a skin, or that they no longer do.
 *
 * `value` is 1, -1, or 0 to withdraw. Changing your mind updates the row you
 * already have rather than adding another, so the totals count people rather
 * than taps — the same reason downloads are collapsed per client per day.
 *
 * The counters on `skins` are recomputed from the reactions themselves inside
 * the same transaction rather than incremented. Incrementing is faster and
 * drifts: a retry, a crash between two writes, or a reaction removed by a
 * cascading delete all leave a total nobody can reconcile. Recomputing cannot
 * disagree with the rows it is derived from.
 */
export const setReaction = transaction((id, clientKey, value) => {
  const skin = db.prepare('SELECT id FROM skins WHERE id = ? AND is_published = 1').get(id);
  if (!skin) return null;
  if (!clientKey) return null;

  if (value === 0) {
    db.prepare('DELETE FROM reactions WHERE skin_id = ? AND client_key = ?').run(id, clientKey);
  } else {
    db.prepare(
      `INSERT INTO reactions (skin_id, client_key, value) VALUES (?, ?, ?)
       ON CONFLICT(skin_id, client_key)
       DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    ).run(id, clientKey, value);
  }

  db.prepare(
    `UPDATE skins SET
       likes    = (SELECT COUNT(*) FROM reactions WHERE skin_id = ? AND value = 1),
       dislikes = (SELECT COUNT(*) FROM reactions WHERE skin_id = ? AND value = -1)
     WHERE id = ?`,
  ).run(id, id, id);

  const totals = db.prepare('SELECT likes, dislikes FROM skins WHERE id = ?').get(id);
  const mine = db
    .prepare('SELECT value FROM reactions WHERE skin_id = ? AND client_key = ?')
    .get(id, clientKey);

  return { ...totals, yours: mine?.value ?? 0 };
});

/** What this client already said about a skin, for the app to show its own state. */
export function reactionFor(id, clientKey) {
  if (!clientKey) return 0;
  const row = db
    .prepare('SELECT value FROM reactions WHERE skin_id = ? AND client_key = ?')
    .get(id, clientKey);
  return row?.value ?? 0;
}

/**
 * Records a download. Returns the new total.
 *
 * `clientKey` collapses repeat downloads from the same client on the same day, so the counter
 * reflects interest rather than how many times someone tapped the button.
 */
export const recordDownload = transaction((id, clientKey) => {
  const skin = db.prepare('SELECT id FROM skins WHERE id = ? AND is_published = 1').get(id);
  if (!skin) return null;

  const day = new Date().toISOString().slice(0, 10);

  if (clientKey) {
    const seen = db
      .prepare('SELECT 1 FROM download_events WHERE skin_id = ? AND day = ? AND client_key = ?')
      .get(id, day, clientKey);
    if (seen) {
      return db.prepare('SELECT downloads FROM skins WHERE id = ?').get(id).downloads;
    }
  }

  db.prepare('INSERT INTO download_events (skin_id, day, client_key) VALUES (?, ?, ?)')
    .run(id, day, clientKey || null);
  db.prepare('UPDATE skins SET downloads = downloads + 1 WHERE id = ?').run(id);

  return db.prepare('SELECT downloads FROM skins WHERE id = ?').get(id).downloads;
});

/**
 * Skins most like this one.
 *
 * Ranked by shared tag count first, then by whether it's the same category, then by popularity.
 * The `UNION`-free fallback matters: a skin with no tags, or with tags nobody else uses, would
 * otherwise show an empty row — so anything short of `limit` is topped up with popular skins
 * from the same category.
 */
export function relatedSkins(id, limit = 8) {
  const source = db.prepare('SELECT id, category FROM skins WHERE id = ?').get(id);
  if (!source) return { rows: [], tags: new Map() };

  const rows = db
    .prepare(
      `SELECT s.*, COUNT(st.tag_id) AS shared
         FROM skins s
         JOIN skin_tags st ON st.skin_id = s.id
        WHERE st.tag_id IN (SELECT tag_id FROM skin_tags WHERE skin_id = @id)
          AND s.id != @id
          AND s.is_published = 1
     GROUP BY s.id
     ORDER BY shared DESC, (s.category = @category) DESC, s.downloads DESC
        LIMIT @limit`
    )
    .all({ id, category: source.category, limit });

  if (rows.length < limit) {
    const exclude = new Set([id, ...rows.map((row) => row.id)]);
    const placeholders = [...exclude].map(() => '?').join(',');
    const filler = db
      .prepare(
        `SELECT s.* FROM skins s
          WHERE s.is_published = 1
            AND s.category = ?
            AND s.id NOT IN (${placeholders})
       ORDER BY s.downloads DESC
          LIMIT ?`
      )
      .all(source.category, ...exclude, limit - rows.length);
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
export function logSearch({ term, category, results }) {
  const cleaned = String(term || '').trim().toLowerCase().slice(0, 60);
  if (cleaned.length < 2) return;

  db.prepare(
    "INSERT INTO search_events (term, category, results, day) VALUES (?, ?, ?, date('now'))"
  ).run(cleaned, category || null, results);
}

export function allTags() {
  return db
    .prepare(
      `SELECT t.name, COUNT(st.skin_id) AS uses
         FROM tags t
    LEFT JOIN skin_tags st ON st.tag_id = t.id
     GROUP BY t.id
     ORDER BY uses DESC, t.name ASC`
    )
    .all();
}

export function logAudit(userId, action, subject, detail) {
  db.prepare('INSERT INTO audit_log (user_id, action, subject, detail) VALUES (?, ?, ?, ?)')
    .run(userId ?? null, action, subject ?? null, detail ?? null);
}
