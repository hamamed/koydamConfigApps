import { db } from './db/index.js';

/**
 * The four authored collections, described rather than hand-written.
 *
 * Leaks, wallpapers, creative maps and weapons are the same shape of problem —
 * a list, a form, publish and delete — differing only in their fields. Four
 * copies of that would be four places to fix the next bug in any of it, and
 * they would drift. So the fields are declared here and the routes and views
 * are generic over them.
 *
 * `type` drives both the form control and the coercion on save:
 *   text     one-line string
 *   textarea long string
 *   url      string, validated as http(s) so a broken image is caught on save
 *   number   real, stored null when blank rather than 0 — an unknown DPS and a
 *            DPS of zero are different facts
 *   int      integer, same rule
 *   select   one of `options`
 *
 * `blank` says what an empty input means for that field, and it is not always
 * the same answer. An unknown DPS is null, because an unknown DPS and a DPS of
 * zero are different facts. An unset sort order is 0, because the column is NOT
 * NULL and "no preference" genuinely is zero — writing null there made the
 * whole insert fail, silently, from an empty optional box.
 */
export const COLLECTIONS = {
  leaks: {
    table: 'leaks',
    label: 'Leaks & rumours',
    singular: 'leak',
    icon: 'megaphone',
    order: 'created_at DESC, id DESC',
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true },
      { name: 'body', label: 'Body', type: 'textarea' },
      { name: 'image_url', label: 'Image URL', type: 'url' },
      { name: 'source', label: 'Source', type: 'text', help: 'Who reported it — a handle or a link.' },
    ],
  },

  wallpapers: {
    table: 'wallpapers',
    label: 'Wallpapers',
    singular: 'wallpaper',
    icon: 'image',
    order: 'sort_order, id DESC',
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true },
      { name: 'image_url', label: 'Full-size URL', type: 'url', required: true },
      { name: 'thumb_url', label: 'Thumbnail URL', type: 'url', help: 'Optional. The full image is used when blank.' },
      { name: 'sort_order', label: 'Sort order', type: 'int', blank: 0 },
    ],
  },

  'creative-maps': {
    table: 'creative_maps',
    label: 'Creative maps',
    singular: 'map',
    icon: 'map',
    order: 'sort_order, id DESC',
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true },
      { name: 'code', label: 'Island code', type: 'text', required: true, help: 'The 12-digit code players paste in game.' },
      { name: 'category', label: 'Category', type: 'text' },
      { name: 'description', label: 'Description', type: 'textarea' },
      { name: 'image_url', label: 'Image URL', type: 'url' },
      { name: 'sort_order', label: 'Sort order', type: 'int', blank: 0 },
    ],
  },

  weapons: {
    table: 'weapons',
    label: 'Weapons',
    singular: 'weapon',
    icon: 'crosshair',
    order: 'sort_order, name',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true },
      {
        name: 'rarity',
        label: 'Rarity',
        type: 'select',
        // The values the app colours from. Kept to the tiers weapons actually
        // ship in — a weapon is never a Marvel series item.
        options: ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'exotic'],
      },
      { name: 'category', label: 'Category', type: 'text', help: 'Assault rifle, shotgun, SMG…' },
      { name: 'damage', label: 'Damage', type: 'number' },
      { name: 'dps', label: 'DPS', type: 'number' },
      { name: 'fire_rate', label: 'Fire rate', type: 'number' },
      { name: 'magazine', label: 'Magazine', type: 'int' },
      { name: 'reload_time', label: 'Reload (s)', type: 'number' },
      { name: 'image_url', label: 'Image URL', type: 'url' },
      { name: 'description', label: 'Description', type: 'textarea' },
      { name: 'sort_order', label: 'Sort order', type: 'int', blank: 0 },
    ],
  },
};

export const collection = (slug) => COLLECTIONS[slug] ?? null;

/** Coerces one submitted form into column values, or reports why it cannot. */
export function readForm(spec, body) {
  const values = {};
  const errors = [];

  for (const field of spec.fields) {
    const raw = String(body?.[field.name] ?? '').trim();

    if (field.required && !raw) {
      errors.push(`${field.label} is required.`);
      continue;
    }

    if (!raw) {
      // Blank means whatever the field says it means. Numbers default to null
      // rather than zero; a column that cannot hold null declares otherwise.
      values[field.name] =
        field.blank !== undefined
          ? field.blank
          : field.type === 'int' || field.type === 'number'
            ? null
            : '';
      continue;
    }

    if (field.type === 'url' && !/^https?:\/\/\S+$/i.test(raw)) {
      errors.push(`${field.label} must be a http:// or https:// address.`);
      continue;
    }

    if (field.type === 'number' || field.type === 'int') {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        errors.push(`${field.label} must be a number.`);
        continue;
      }
      values[field.name] = field.type === 'int' ? Math.round(n) : n;
      continue;
    }

    if (field.type === 'select' && field.options && !field.options.includes(raw)) {
      errors.push(`${field.label} is not one of the allowed values.`);
      continue;
    }

    values[field.name] = raw;
  }

  return { values, errors };
}

export function listRows(spec, { limit = 200 } = {}) {
  return db.prepare(`SELECT * FROM ${spec.table} ORDER BY ${spec.order} LIMIT ?`).all(limit);
}

export function getRow(spec, id) {
  return db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).get(id);
}

export function insertRow(spec, values) {
  const names = Object.keys(values);
  const info = db
    .prepare(
      `INSERT INTO ${spec.table} (${names.join(', ')})
       VALUES (${names.map((n) => `@${n}`).join(', ')})`,
    )
    .run(values);
  return info.lastInsertRowid;
}

export function updateRow(spec, id, values) {
  const names = Object.keys(values);
  if (!names.length) return;
  db.prepare(
    `UPDATE ${spec.table} SET ${names.map((n) => `${n} = @${n}`).join(', ')} WHERE id = @id`,
  ).run({ ...values, id });
}

export function togglePublished(spec, id) {
  db.prepare(`UPDATE ${spec.table} SET is_published = 1 - is_published WHERE id = ?`).run(id);
}

export function deleteRow(spec, id) {
  db.prepare(`DELETE FROM ${spec.table} WHERE id = ?`).run(id);
}

export function counts() {
  const out = {};
  for (const [slug, spec] of Object.entries(COLLECTIONS)) {
    out[slug] = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN is_published = 1 THEN 1 ELSE 0 END) AS published
           FROM ${spec.table}`,
      )
      .get();
  }
  return out;
}
