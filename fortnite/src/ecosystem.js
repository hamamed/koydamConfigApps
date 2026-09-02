import { config } from './config.js';
import { db, transaction } from './db/index.js';

/**
 * Epic's official Ecosystem API.
 *
 * Public, unauthenticated, and the only sanctioned source of creative island
 * data — fortnite.gg is behind a bot challenge and fortnite-api.com has no
 * island endpoint at all.
 *
 * Two things about it shape everything here. It has no sorting, filtering or
 * search: every such parameter is accepted and ignored, so the catalogue has
 * to be mirrored locally to be useful. And its metrics endpoint returns only
 * the last two days, so any history longer than that is history this service
 * kept, not history Epic served.
 */
const BASE = 'https://api.fortnite.com/ecosystem/v1';

/** Epic answers a bare client with 403, so a browser-shaped agent is sent. */
const AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function get(path, { timeout = 30_000 } = {}) {
  const response = await fetch(BASE + path, {
    headers: { Accept: 'application/json', 'User-Agent': AGENT },
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) throw new Error(`Ecosystem ${path} returned ${response.status}`);
  return response.json();
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
 * Walks the island catalogue and upserts what it finds.
 *
 * Bounded by pages rather than run to exhaustion: the catalogue is north of
 * twenty thousand islands and grows, and a job that always reads all of it
 * would spend a minute of every run re-reading what it already has. The cursor
 * is kept, so each run continues where the last stopped and the whole
 * catalogue is covered over a handful of runs.
 */
export async function syncIslands({ pages = 40 } = {}) {
  try {
    const upsert = db.prepare(
      `INSERT INTO islands (code, title, creator_code, category, created_in, tags, search_blob, synced_at)
       VALUES (@code, @title, @creator_code, @category, @created_in, @tags, @search_blob, datetime('now'))
       ON CONFLICT(code) DO UPDATE SET
         title = excluded.title,
         creator_code = excluded.creator_code,
         category = excluded.category,
         created_in = excluded.created_in,
         tags = excluded.tags,
         search_blob = excluded.search_blob,
         synced_at = datetime('now')`,
    );

    let cursor = cursorFor('islands');
    let seen = 0;

    for (let page = 0; page < pages; page += 1) {
      const query = `/islands?size=100${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
      const body = await get(query);
      const rows = body?.data ?? [];
      if (!rows.length) { cursor = null; break; }

      transaction((items) => {
        for (const island of items) {
          const title = island.title ?? island.code;
          const tags = Array.isArray(island.tags) ? island.tags : [];
          upsert.run({
            code: island.code,
            title,
            creator_code: island.creatorCode ?? null,
            category: island.category ?? null,
            created_in: island.createdIn ?? null,
            tags: JSON.stringify(tags),
            search_blob: [title, island.creatorCode, island.category, ...tags]
              .filter(Boolean).join(' ').toLowerCase(),
          });
        }
      })(rows);

      seen += rows.length;
      cursor = body?.meta?.page?.nextCursor ?? null;
      if (!cursor) break;
    }

    // A null cursor means the end was reached; the next run starts over, which
    // is how an island that changed its title gets picked up again.
    saveCursor('islands', cursor);
    record('islands', { count: db.prepare('SELECT COUNT(*) AS n FROM islands').get().n });
    return seen;
  } catch (err) {
    record('islands', { error: err.message });
    throw err;
  }
}

/**
 * Fetches metrics for a slice of the catalogue.
 *
 * One request per island and twenty thousand islands means fetching everything
 * is not on the table. Instead a bounded batch runs each time, oldest-first,
 * so the whole catalogue is covered in rotation and nothing goes stale
 * indefinitely. Islands already known to be busy are refreshed first, because
 * those are the ones the app actually shows.
 */
export async function syncIslandMetrics({ batch = 120 } = {}) {
  try {
    // Order of interest: islands that have real numbers, then ones never
    // asked, then ones that came back empty — least often asked last. Epic
    // reports nulls for most of the catalogue, so without the miss count the
    // rotation spends itself re-confirming that a dead island is still dead.
    const targets = db
      .prepare(
        `SELECT code FROM islands
          ORDER BY CASE
                     WHEN peak_ccu IS NOT NULL THEN 0
                     WHEN metrics_at IS NULL    THEN 1
                     ELSE 2
                   END,
                   metrics_misses ASC,
                   peak_ccu DESC,
                   metrics_at ASC
          LIMIT ?`,
      )
      .all(batch);

    if (!targets.length) { record('island-metrics', { count: 0 }); return 0; }

    const insert = db.prepare(
      `INSERT INTO island_metrics (code, day, peak_ccu, unique_players, plays, minutes_played,
                                   avg_minutes, favorites, recommendations, retention)
       VALUES (@code, @day, @peak_ccu, @unique_players, @plays, @minutes_played,
               @avg_minutes, @favorites, @recommendations, @retention)
       ON CONFLICT(code, day) DO UPDATE SET
         peak_ccu = excluded.peak_ccu, unique_players = excluded.unique_players,
         plays = excluded.plays, minutes_played = excluded.minutes_played,
         avg_minutes = excluded.avg_minutes, favorites = excluded.favorites,
         recommendations = excluded.recommendations, retention = excluded.retention,
         recorded_at = datetime('now')`,
    );

    const touch = db.prepare(
      `UPDATE islands SET peak_ccu = @peak_ccu, unique_players = @unique_players,
                          plays = @plays, minutes_played = @minutes_played,
                          favorites = @favorites, recommendations = @recommendations,
                          avg_minutes = @avg_minutes, retention = @retention,
                          metrics_at = datetime('now')
        WHERE code = @code`,
    );

    let updated = 0;

    for (const { code } of targets) {
      let metrics;
      try {
        metrics = await get(`/islands/${encodeURIComponent(code)}/metrics`, { timeout: 15_000 });
      } catch {
        // A single island failing is not a failed run. Stamping it anyway stops
        // one permanently broken code from being retried ahead of everything
        // else forever.
        db.prepare(
          `UPDATE islands SET metrics_at = datetime('now'),
                              metrics_misses = metrics_misses + 1
            WHERE code = ?`,
        ).run(code);
        continue;
      }

      const days = seriesByDay(metrics);

      // Epic answers for every island; most answers are entirely null. That is
      // a miss, not a failure, and it is the common case.
      const hasNumbers = [...days.values()].some((row) =>
        Object.values(row).some((v) => v != null));

      if (!days.size || !hasNumbers) {
        db.prepare(
          `UPDATE islands SET metrics_at = datetime('now'),
                              metrics_misses = metrics_misses + 1
            WHERE code = ?`,
        ).run(code);
        continue;
      }

      transaction(() => {
        for (const [day, values] of days) insert.run({ code, day, ...values });
        db.prepare('UPDATE islands SET metrics_misses = 0 WHERE code = ?').run(code);

        // The newest day that actually has numbers — not simply the newest.
        //
        // Epic returns today alongside yesterday, and today is usually still
        // empty because the day has not finished. Copying it verbatim wiped
        // yesterday's real figures off the island row, so the list could not
        // see them: forty-two islands had metrics in history and read as
        // unmeasured.
        const withData = [...days.entries()]
          .sort(([a], [b]) => b.localeCompare(a))
          .find(([, values]) => Object.values(values).some((v) => v != null));

        if (withData) touch.run({ code, ...withData[1] });
      })();

      updated += 1;
    }

    record('island-metrics', { count: updated });
    return updated;
  } catch (err) {
    record('island-metrics', { error: err.message });
    throw err;
  }
}

/**
 * Turns Epic's per-metric series into one row per day.
 *
 * The response is eight independent arrays of `{value, timestamp}`, which is
 * the wrong shape for storage — a day is one fact about an island, not eight.
 */
function seriesByDay(metrics) {
  const fields = {
    peakCCU: 'peak_ccu',
    uniquePlayers: 'unique_players',
    plays: 'plays',
    minutesPlayed: 'minutes_played',
    averageMinutesPerPlayer: 'avg_minutes',
    favorites: 'favorites',
    recommendations: 'recommendations',
    retention: 'retention',
  };

  const days = new Map();

  for (const [key, column] of Object.entries(fields)) {
    for (const point of metrics?.[key] ?? []) {
      const day = String(point?.timestamp ?? '').slice(0, 10);
      if (!day) continue;
      if (!days.has(day)) {
        days.set(day, Object.fromEntries(Object.values(fields).map((c) => [c, null])));
      }
      days.get(day)[column] = point?.value ?? null;
    }
  }

  return days;
}

// The paging cursor, kept between runs so a job resumes rather than restarts.
function cursorFor(feed) {
  return db.prepare('SELECT last_error FROM sync_state WHERE feed = ?').get(`${feed}-cursor`)
    ?.last_error ?? null;
}

function saveCursor(feed, cursor) {
  db.prepare(
    `INSERT INTO sync_state (feed, last_try_at, last_error)
     VALUES (?, datetime('now'), ?)
     ON CONFLICT(feed) DO UPDATE SET last_try_at = datetime('now'), last_error = excluded.last_error`,
  ).run(`${feed}-cursor`, cursor);
}

/**
 * Drops history past the retention window.
 *
 * Six months of daily rows for a few thousand measured islands is on the order
 * of a million rows — comfortable for SQLite, and worth keeping because Epic
 * serves two days and nothing more. Beyond that the value falls away faster
 * than the cost does.
 *
 * Runs after a metrics pass rather than on its own timer: there is no point
 * pruning a table nothing has just written to.
 */
export function pruneMetrics({ days = 185 } = {}) {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const info = db.prepare('DELETE FROM island_metrics WHERE day < ?').run(cutoff);
  return info.changes;
}

/** What the panel and the API report about stored history. */
export function historySummary() {
  return db
    .prepare(
      `SELECT COUNT(*) AS rows,
              COUNT(DISTINCT code) AS islands,
              MIN(day) AS since,
              MAX(day) AS until
         FROM island_metrics`,
    )
    .get();
}
