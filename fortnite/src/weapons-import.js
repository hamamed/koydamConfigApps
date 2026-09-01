/**
 * Parsing a pasted weapons table.
 *
 * What arrives is whatever the browser put on the clipboard when a table was
 * selected and copied — in practice tab-separated columns and newline-separated
 * rows, but with no guarantee about which columns are present, what order they
 * are in, or whether a header came along. So nothing here assumes a layout: the
 * header names the columns when there is one, and the shape of the values names
 * them when there is not.
 *
 * Nothing is written from this file. It returns what it understood and what it
 * could not, and the panel shows both before anything is saved — a bulk import
 * that silently guesses wrong is worse than one that refuses.
 */

const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'exotic'];

/** Column names, and the many things a site might call them. */
const FIELDS = {
  name: ['name', 'weapon', 'item', 'title'],
  rarity: ['rarity', 'tier', 'quality'],
  category: ['category', 'type', 'class', 'kind'],
  damage: ['damage', 'dmg', 'body damage', 'body'],
  dps: ['dps', 'damage per second'],
  fire_rate: ['fire rate', 'firerate', 'rate of fire', 'rof', 'rate'],
  magazine: ['magazine', 'mag', 'mag size', 'magazine size', 'clip', 'ammo'],
  reload_time: ['reload', 'reload time', 'reloadtime', 'reload speed'],
};

const NUMERIC = new Set(['damage', 'dps', 'fire_rate', 'magazine', 'reload_time']);

/** Splits a pasted line into cells. */
function cells(line) {
  // Tabs are what a copied table produces. Falling back to runs of two or more
  // spaces catches a paste that has been through something which flattened
  // them — a single space is not a separator, because weapon names contain
  // spaces and splitting on one would shatter every row.
  const parts = line.includes('\t') ? line.split('\t') : line.split(/ {2,}|\s*\|\s*/);
  return parts.map((c) => c.trim()).filter((c, i, all) => !(c === '' && i === all.length - 1));
}

function matchField(heading) {
  const clean = heading.toLowerCase().replace(/[^a-z ]/g, '').trim();
  for (const [field, names] of Object.entries(FIELDS)) {
    if (names.includes(clean)) return field;
  }
  // Loose match second, so "Damage" wins over "Damage per second" for `damage`.
  for (const [field, names] of Object.entries(FIELDS)) {
    if (names.some((n) => clean.startsWith(n))) return field;
  }
  return null;
}

/** A number out of "12.5", "1,200", "0.65s", "×3". Blank and dashes are unknown. */
function num(value) {
  if (value == null) return null;
  const cleaned = String(value).replace(/,/g, '').replace(/[^0-9.]/g, '');
  if (!cleaned || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function rarityOf(value) {
  const clean = String(value ?? '').toLowerCase().trim();
  return RARITIES.find((r) => clean === r) ?? RARITIES.find((r) => clean.includes(r)) ?? null;
}

/**
 * Works out what each column is when there is no header.
 *
 * By shape rather than by position: the first column holding mostly words is
 * the name, a column whose values are all rarity words is the rarity, and the
 * numeric ones are assigned in the order sites conventionally print them.
 * Wrong guesses are the reason the panel previews before it saves.
 */
function inferColumns(rows) {
  const width = Math.max(...rows.map((r) => r.length));
  const map = {};
  const numericColumns = [];

  for (let c = 0; c < width; c += 1) {
    const values = rows.map((r) => r[c]).filter((v) => v != null && v !== '');
    if (!values.length) continue;

    if (values.every((v) => rarityOf(v))) { map[c] = 'rarity'; continue; }

    const numeric = values.filter((v) => num(v) != null).length / values.length;
    if (numeric > 0.7) { numericColumns.push(c); continue; }

    if (map.name === undefined && !Object.values(map).includes('name')) {
      map[c] = 'name';
      continue;
    }
    if (!Object.values(map).includes('category')) map[c] = 'category';
  }

  // The usual printing order on a stats table.
  const order = ['dps', 'damage', 'fire_rate', 'magazine', 'reload_time'];
  numericColumns.forEach((c, i) => { if (order[i]) map[c] = order[i]; });
  return map;
}

export function parseWeapons(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (!lines.length) return { rows: [], skipped: [], columns: {}, hadHeader: false };

  let grid = lines.map(cells);

  // A header is a first row where at least two cells name a known column and
  // none of them parse as a number — "Name Rarity DPS" rather than "Pump 500".
  let columns = {};
  let hadHeader = false;
  const first = grid[0];
  const named = first.map(matchField).filter(Boolean);
  if (named.length >= 2 && first.every((c) => num(c) === null || matchField(c))) {
    first.forEach((heading, i) => {
      const field = matchField(heading);
      if (field) columns[i] = field;
    });
    grid = grid.slice(1);
    hadHeader = true;
  } else {
    columns = inferColumns(grid);
  }

  const rows = [];
  const skipped = [];

  for (const [index, cellsOfRow] of grid.entries()) {
    const weapon = { name: '', rarity: 'common', category: null };

    for (const [column, field] of Object.entries(columns)) {
      const raw = cellsOfRow[Number(column)];
      if (raw == null || raw === '') continue;

      if (field === 'rarity') weapon.rarity = rarityOf(raw) ?? 'common';
      else if (NUMERIC.has(field)) weapon[field] = num(raw);
      else weapon[field] = String(raw).trim();
    }

    // A row with no name is a separator, a total, or a misparse. None of those
    // is a weapon, and inventing a name for it would put junk in the panel.
    if (!weapon.name) {
      skipped.push({ line: index + (hadHeader ? 2 : 1), text: cellsOfRow.join(' | '), why: 'no name' });
      continue;
    }

    // A name and nothing else is not a weapon either. Paste a sentence in here
    // and every word of it lands in one cell, which parses perfectly happily as
    // an item called "hello there this is not a table" — the preview would show
    // it, but a rule that catches it is better than relying on someone reading
    // carefully at the end of a long import.
    const hasStat = [...NUMERIC].some((field) => weapon[field] != null);
    if (!hasStat) {
      skipped.push({
        line: index + (hadHeader ? 2 : 1),
        text: cellsOfRow.join(' | '),
        why: 'no stats — not a weapon row',
      });
      continue;
    }

    rows.push(weapon);
  }

  return { rows, skipped, columns, hadHeader };
}

export { RARITIES };
