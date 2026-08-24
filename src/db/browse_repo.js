/**
 * Read-only table browsing for the admin panel.
 *
 * ## Why a whitelist rather than escaping
 *
 * A table name cannot be a bind parameter — Postgres only parameterises values,
 * so `SELECT * FROM $1` is not a thing. That leaves interpolation, and
 * interpolating a caller-supplied identifier into SQL is how injection happens.
 *
 * So the name never comes from the request. The request picks an entry from
 * this map by key, and the SQL is built from the map's own values, which are
 * literals in this file. A key that isn't here is rejected before any query is
 * built.
 */

import { query } from './pool.js';

/**
 * Browsable tables, each with the column it sorts by.
 *
 * `orderBy` is a literal too — the same argument applies to it as to the table
 * name, and "newest first" is the only ordering a browser needs.
 */
const TABLES = {
  crawl_runs: { orderBy: 'started_at DESC', label: 'Crawl runs' },
  battles: { orderBy: 'battle_time DESC NULLS LAST', label: 'Battles' },
  battle_players: {
    orderBy: 'battle_time DESC NULLS LAST',
    label: 'Battle players',
  },
  battle_samples: {
    orderBy: 'battle_time DESC NULLS LAST',
    label: 'Battle samples (legacy)',
  },
  brawler_stats: { orderBy: 'recorded_at DESC', label: 'Brawler stats' },
  players_seen: { orderBy: 'last_seen DESC', label: 'Players' },
  player_brawlers: { orderBy: 'updated_at DESC', label: 'Player rosters' },
  player_snapshots: { orderBy: 'at DESC', label: 'Trophy snapshots' },
  crawl_queue: {
    orderBy: 'priority ASC, discovered_at ASC',
    label: 'Crawl queue',
  },
  map_rotations: {
    orderBy: 'COALESCE(start_time, first_seen) DESC',
    label: 'Map rotations',
  },
};

/** Table keys and labels, for the picker. */
export function browsableTables() {
  return Object.entries(TABLES).map(([name, t]) => ({
    name,
    label: t.label,
  }));
}

/**
 * The newest rows of one table.
 *
 * No offset paging. These tables reach tens of millions of rows and a deep
 * OFFSET makes Postgres walk every skipped row — a browser that gets slower the
 * further you scroll is worse than one that only shows the top.
 */
export async function browseTable(name, limit = 50) {
  const table = TABLES[name];
  if (!table) return null;

  const capped = Math.min(Math.max(Number(limit) || 50, 1), 200);

  // `name` and `orderBy` come from TABLES above, never from the caller. The
  // caller only ever chose a key.
  const res = await query(
    `SELECT * FROM ${name} ORDER BY ${table.orderBy} LIMIT $1`,
    [capped],
  );

  if (!res) return { name, label: table.label, columns: [], rows: [] };

  return {
    name,
    label: table.label,
    // From the result descriptor rather than the first row, so a table with no
    // rows still renders its headers instead of collapsing to nothing.
    columns: (res.fields ?? []).map((f) => f.name),
    rows: (res.rows ?? []).map(stringifyRow),
  };
}

/**
 * Flattens a row to display strings.
 *
 * The panel renders every cell as a text node — upstream player and club names
 * are user-controlled, and this data has already crossed a trust boundary once.
 * Converting here means the renderer never has to decide what a value is.
 */
function stringifyRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) {
      out[key] = null;
    } else if (value instanceof Date) {
      out[key] = value.toISOString();
    } else if (typeof value === 'object') {
      out[key] = JSON.stringify(value);
    } else {
      out[key] = String(value);
    }
  }
  return out;
}

/**
 * Live row counts for every browsable table.
 *
 * `pg_class.reltuples` is an estimate that reads -1 until a table has been
 * analysed, which is why the panel has been showing -1 for the newer tables.
 * This counts for real, but only up to a ceiling: a bare COUNT(*) over
 * `battle_players` at thirty million rows would scan all of them every refresh.
 */
export async function tableCounts() {
  const names = Object.keys(TABLES);
  const counts = {};

  for (const name of names) {
    const res = await query(
      `SELECT COUNT(*)::bigint AS n FROM (
         SELECT 1 FROM ${name} LIMIT 5000000
       ) capped`,
    );
    const n = Number(res?.rows?.[0]?.n ?? 0);
    counts[name] = { rows: n, capped: n >= 5_000_000 };
  }

  return counts;
}
