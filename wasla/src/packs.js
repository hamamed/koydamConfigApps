/**
 * Packs: themed groups of levels, each with a colour and an SF Symbol.
 *
 * Both come from fixed lists. The colours are the game's own, so a pack never
 * clashes with the board; the icons are SF Symbols the app can draw, and since
 * a browser cannot render SF Symbols, each carries the Lucide icon that looks
 * most like it for the panel's picker.
 */

export const GENERAL_PACK = Object.freeze({
  slug: 'general',
  title: 'عام',
  color: '#4E4A8C',
  icon: 'square.grid.3x3.fill',
});

/** [hex, name] — from Palette.swift in the app. */
export const PACK_COLORS = [
  ['#14A49E', 'Teal'],
  ['#0E7F7A', 'Deep teal'],
  ['#0B5A78', 'Ocean'],
  ['#4E4A8C', 'Indigo'],
  ['#36336A', 'Deep indigo'],
  ['#C9951A', 'Gold'],
  ['#FF7A59', 'Coral'],
  ['#D8483B', 'Red'],
  ['#2E9B74', 'Green'],
];

/** [SF Symbol, Lucide look-alike] */
export const PACK_ICONS = [
  ['square.grid.3x3.fill', 'grid-3x3'],
  ['globe.europe.africa.fill', 'globe'],
  ['building.columns.fill', 'landmark'],
  ['mappin.and.ellipse', 'map-pin'],
  ['flag.fill', 'flag'],
  ['airplane', 'plane'],
  ['pawprint.fill', 'paw-print'],
  ['fish.fill', 'fish'],
  ['tortoise.fill', 'turtle'],
  ['leaf.fill', 'leaf'],
  ['tree.fill', 'tree-pine'],
  ['sun.max.fill', 'sun'],
  ['moon.stars.fill', 'moon-star'],
  ['fork.knife', 'utensils'],
  ['carrot.fill', 'carrot'],
  ['cup.and.saucer.fill', 'coffee'],
  ['house.fill', 'house'],
  ['car.fill', 'car'],
  ['tshirt.fill', 'shirt'],
  ['cart.fill', 'shopping-cart'],
  ['book.fill', 'book'],
  ['books.vertical.fill', 'library'],
  ['lightbulb.fill', 'lightbulb'],
  ['brain.head.profile', 'brain'],
  ['flask.fill', 'flask-conical'],
  ['music.note', 'music'],
  ['film.fill', 'film'],
  ['camera.fill', 'camera'],
  ['paintpalette.fill', 'palette'],
  ['gamecontroller.fill', 'gamepad-2'],
  ['sportscourt.fill', 'volleyball'],
  ['trophy.fill', 'trophy'],
  ['person.2.fill', 'users'],
  ['heart.fill', 'heart'],
  ['star.fill', 'star'],
  ['sparkles', 'sparkles'],
];

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SLUG = 40;
export const MAX_PACK_TITLE = 60;

const iso = (value) => (value ? `${value.replace(' ', 'T')}Z` : null);

const toPack = (row) => row && ({
  id: row.id,
  slug: row.slug,
  title: row.title,
  color: row.color,
  icon: row.icon,
  position: row.position,
  levelCount: row.level_count ?? 0,
  publishedCount: row.published_count ?? 0,
  updatedAt: iso(row.updated_at),
});

/** Validated pack fields, or `{ error }`. */
function readPack(input) {
  const title = String(input.title ?? '').trim();
  if (!title) return { error: 'A pack needs a title.' };
  if (title.length > MAX_PACK_TITLE) return { error: `A pack title can be at most ${MAX_PACK_TITLE} characters.` };

  const slug = String(input.slug ?? '').trim().toLowerCase();
  if (!SLUG.test(slug) || slug.length > MAX_SLUG) {
    return { error: 'The slug must be lowercase Latin letters, digits and single hyphens, e.g. world-capitals.' };
  }
  if (slug === GENERAL_PACK.slug) return { error: `“${GENERAL_PACK.slug}” is reserved for levels without a pack.` };

  const color = String(input.color ?? '').toUpperCase();
  if (!PACK_COLORS.some(([hex]) => hex === color)) return { error: 'Pick one of the pack colours.' };

  const icon = String(input.icon ?? '');
  if (!PACK_ICONS.some(([symbol]) => symbol === icon)) return { error: 'Pick one of the pack icons.' };

  return { fields: { title, slug, color, icon } };
}

export function createPackStore(db) {
  const SELECT = `SELECT p.*,
      (SELECT COUNT(*) FROM levels l WHERE l.pack_id = p.id) AS level_count,
      (SELECT COUNT(*) FROM levels l WHERE l.pack_id = p.id AND l.published = 1) AS published_count
    FROM packs p`;

  function listPacks() {
    return db.prepare(`${SELECT} ORDER BY p.position, p.id`).all().map(toPack);
  }

  function getPack(id) {
    return toPack(db.prepare(`${SELECT} WHERE p.id = ?`).get(id));
  }

  const slugTaken = (slug, exceptId = 0) =>
    Boolean(db.prepare('SELECT 1 FROM packs WHERE slug = ? AND id != ?').get(slug, exceptId));

  function createPack(input) {
    const { fields, error } = readPack(input);
    if (error) return { error };
    if (slugTaken(fields.slug)) return { error: `Another pack already uses the slug “${fields.slug}”.` };
    const { next } = db.prepare('SELECT IFNULL(MAX(position), 0) + 1 AS next FROM packs').get();
    const { lastInsertRowid } = db.prepare(`INSERT INTO packs (slug, title, color, icon, position)
      VALUES (@slug, @title, @color, @icon, @position)`).run({ ...fields, position: next });
    return { pack: getPack(lastInsertRowid) };
  }

  function updatePack(id, input) {
    if (!getPack(id)) return { error: 'That pack no longer exists.' };
    const { fields, error } = readPack(input);
    if (error) return { error };
    if (slugTaken(fields.slug, id)) return { error: `Another pack already uses the slug “${fields.slug}”.` };
    db.prepare(`UPDATE packs SET slug = @slug, title = @title, color = @color, icon = @icon,
      updated_at = datetime('now') WHERE id = @id`).run({ ...fields, id });
    return { pack: getPack(id) };
  }

  /** Its levels move to the general pack; nothing else is lost. */
  function deletePack(id) {
    db.transaction(() => {
      // Explicit rather than trusting ON DELETE SET NULL: a column added by
      // ALTER TABLE on an old database is the kind of place that gets missed.
      db.prepare("UPDATE levels SET pack_id = NULL, updated_at = datetime('now') WHERE pack_id = ?").run(id);
      db.prepare('DELETE FROM packs WHERE id = ?').run(id);
    })();
  }

  /** Swaps a pack with its neighbour, rewriting positions densely. */
  function movePack(id, direction) {
    const packs = listPacks();
    const i = packs.findIndex((p) => p.id === Number(id));
    const j = direction === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= packs.length) return;
    db.transaction(() => {
      const order = packs.map((p) => p.id);
      [order[i], order[j]] = [order[j], order[i]];
      const set = db.prepare('UPDATE packs SET position = ? WHERE id = ?');
      order.forEach((packId, k) => set.run(k + 1, packId));
    })();
  }

  /** What GET /packs returns: packs with published levels, general last. */
  function publishedPacks() {
    const packs = listPacks();
    const listed = packs
      .filter((p) => p.publishedCount > 0)
      .map((p) => ({ slug: p.slug, title: p.title, color: p.color, icon: p.icon, levelCount: p.publishedCount, position: p.position }));

    const { n } = db.prepare('SELECT COUNT(*) AS n FROM levels WHERE published = 1 AND pack_id IS NULL').get();
    if (n > 0) {
      const last = packs.reduce((max, p) => Math.max(max, p.position), 0);
      listed.push({ ...GENERAL_PACK, levelCount: n, position: last + 1 });
    }
    return listed;
  }

  return { listPacks, getPack, createPack, updatePack, deletePack, movePack, publishedPacks };
}
