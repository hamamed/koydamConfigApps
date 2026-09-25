/**
 * Anonymous gameplay events from the app, and the stats built from them.
 *
 * The app posts batches; a batch with a bad envelope is refused, but a bad or
 * unknown event inside a good batch is only skipped. An app older or newer
 * than this server sends types it does not know, and refusing the batch would
 * make the app retry the same events forever and lose the good ones with them.
 */

import { levelLabel } from './level-label.js';

export const EVENT_TYPES = ['question_opened', 'question_solved', 'help_used', 'question_left', 'level_completed'];
/** The daily word search (contract §5). Always `level: 0`; `word` is a question id. */
export const WORD_SEARCH_TYPES = ['wordsearch_started', 'wordsearch_word_found', 'wordsearch_completed'];
/**
 * The daily games (contract §6, §9): one event each when finished, `level: 0`,
 * with `seconds` and `stars`. `marathon_completed` is Friday's run.
 *
 * The first three games are gone from the app, but their events are still
 * accepted: a phone that has not updated yet is still playing them, and its
 * history should not be thrown away at the door.
 */
export const DAILY_GAME_TYPES = ['wheel_completed', 'guess_completed', 'connect_completed', 'marathon_completed',
  'scramble_completed', 'bubbles_completed', 'groups_completed'];
const DAILY_TYPES = [...WORD_SEARCH_TYPES, ...DAILY_GAME_TYPES];
const KNOWN_TYPES = [...EVENT_TYPES, ...DAILY_TYPES];
/** The crossword's per-question events, which the question stats count. */
const QUESTION_TYPES = ['question_opened', 'question_solved', 'help_used', 'question_left'];
export const HELPS = ['revealLetter', 'removeLetters', 'solveWord', 'unzoomImage', 'unblurImage', 'askFriend'];
export const MAX_EVENTS = 100;
export const RETENTION_DAYS = 180;

/** A question counts as hard below this solve rate, once it has enough opens to say. */
export const HARD_SOLVE_RATE = 0.5;
export const HARD_MIN_OPENS = 10;

const DEVICE = /^[A-Za-z0-9-]{8,64}$/;
const MAX_SECONDS = 86_400;
const MAX_LEVEL = 1_000_000;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const intIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const secondsOk = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_SECONDS;

/** The stored form of one event, or null to skip it. */
function readEvent(raw) {
  if (!isObject(raw) || !KNOWN_TYPES.includes(raw.type)) return null;
  if (!intIn(raw.level, 0, MAX_LEVEL)) return null;
  // The word search is only ever the daily puzzle.
  if (DAILY_TYPES.includes(raw.type) && raw.level !== 0) return null;

  const at = typeof raw.at === 'string' && !Number.isNaN(Date.parse(raw.at)) ? new Date(raw.at).toISOString() : null;
  const event = { type: raw.type, level: raw.level, word: null, help: null, seconds: null, stars: null, at };

  if (raw.type === 'wordsearch_started') return event;

  if (raw.type === 'level_completed' || raw.type === 'wordsearch_completed' || DAILY_GAME_TYPES.includes(raw.type)) {
    if (!secondsOk(raw.seconds) || !intIn(raw.stars, 0, 3)) return null;
    return { ...event, seconds: raw.seconds, stars: raw.stars };
  }

  if (!intIn(raw.word, 1, Number.MAX_SAFE_INTEGER)) return null;
  const withWord = { ...event, word: raw.word };
  if (raw.type === 'question_solved') return secondsOk(raw.seconds) ? { ...withWord, seconds: raw.seconds } : null;
  if (raw.type === 'help_used') return HELPS.includes(raw.help) ? { ...withWord, help: raw.help } : null;
  return withWord;
}

/** `{ device, events }` ready to record, or `{ error }` for a 400. */
export function readEventBatch(body) {
  if (!isObject(body)) return { error: 'The body must be a JSON object with "device" and "events".' };
  if (typeof body.device !== 'string' || !DEVICE.test(body.device)) {
    return { error: '"device" must be the random id the app generated (8 to 64 letters, digits or hyphens).' };
  }
  if (!Array.isArray(body.events)) return { error: '"events" must be a list.' };
  if (body.events.length > MAX_EVENTS) return { error: `At most ${MAX_EVENTS} events per request.` };
  return { device: body.device, events: body.events.map(readEvent).filter(Boolean) };
}

export function createEvents(db, repo) {
  const insert = db.prepare(`INSERT INTO events (device, type, level_number, level_id, word, help, seconds, stars, at)
    VALUES (@device, @type, @level, @levelId, @word, @help, @seconds, @stars, @at)`);

  /** Stores a checked batch in one transaction. Returns how many were stored. */
  function record({ device, events }) {
    if (!events.length) return 0;
    // Level numbers follow the published order, which the panel can change;
    // the id at the time of play keeps a level's history with that level.
    const ids = repo.publishedLevelIds();
    db.transaction(() => {
      for (const event of events) {
        insert.run({ ...event, device, levelId: event.level > 0 ? (ids[event.level - 1] ?? null) : null });
      }
    })();
    return events.length;
  }

  /** Deletes events received more than `days` ago. Returns how many. */
  function prune(days = RETENTION_DAYS) {
    return db.prepare("DELETE FROM events WHERE received_at < datetime('now', ?)").run(`-${Number(days)} days`).changes;
  }

  // Sort keys the Stats page may ask for, mapped to SQL. Nothing else reaches ORDER BY.
  const QUESTION_SORTS = {
    answer: 'q.answer',
    opens: 'opens',
    solves: 'solves',
    solveRate: 'solve_rate',
    avgSeconds: 'avg_seconds',
    helps: 'helps_per_open',
    left: 'lefts',
    devices: 'devices',
  };

  const helpColumns = HELPS.map((h) => `SUM(type = 'help_used' AND help = '${h}') AS help_${h}`).join(',\n        ');

  function questionStats({ sort = 'opens', dir = 'desc', hard = false } = {}) {
    const column = QUESTION_SORTS[sort] ?? QUESTION_SORTS.opens;
    const direction = dir === 'asc' ? 'ASC' : 'DESC';
    const rows = db.prepare(`
      WITH agg AS (
        SELECT word,
          SUM(type = 'question_opened') AS opens,
          SUM(type = 'question_solved') AS solves,
          AVG(CASE WHEN type = 'question_solved' THEN seconds END) AS avg_seconds,
          SUM(type = 'question_left') AS lefts,
          SUM(type = 'help_used') AS helps,
          ${helpColumns},
          COUNT(DISTINCT device) AS devices
        FROM events WHERE word IS NOT NULL AND type IN (${QUESTION_TYPES.map((t) => `'${t}'`).join(', ')}) GROUP BY word
      )
      SELECT q.id, q.answer, q.clue, q.title, q.type, q.image_file, q.image_zoom, q.focus_x, q.focus_y,
        a.avg_seconds, a.helps, ${HELPS.map((h) => `a.help_${h}`).join(', ')},
        IFNULL(a.opens, 0) AS opens, IFNULL(a.solves, 0) AS solves,
        IFNULL(a.lefts, 0) AS lefts, IFNULL(a.devices, 0) AS devices,
        CASE WHEN a.opens > 0 THEN 1.0 * a.solves / a.opens END AS solve_rate,
        CASE WHEN a.opens > 0 THEN 1.0 * a.helps / a.opens END AS helps_per_open
      FROM questions q LEFT JOIN agg a ON a.word = q.id
      ${hard ? 'WHERE a.opens >= @minOpens AND 1.0 * a.solves / a.opens < @rate' : ''}
      -- A question with no opens has no rate or time; it goes last either way.
      ORDER BY (${column} IS NULL), ${column} ${direction}, q.id DESC`).all(hard ? { minOpens: HARD_MIN_OPENS, rate: HARD_SOLVE_RATE } : {});

    return rows.map((row) => ({
      questionId: row.id,
      answer: row.answer,
      clue: row.clue,
      title: row.title || '',
      type: row.type,
      imageFile: row.image_file,
      zoom: row.image_zoom,
      focusX: row.focus_x,
      focusY: row.focus_y,
      opens: row.opens,
      solves: row.solves,
      solveRate: row.solve_rate,
      avgSeconds: row.avg_seconds,
      left: row.lefts,
      devices: row.devices,
      helps: row.helps ?? 0,
      helpsPerOpen: Object.fromEntries(HELPS.map((h) => [h, row.opens ? (row[`help_${h}`] ?? 0) / row.opens : 0])),
      isHard: row.opens >= HARD_MIN_OPENS && row.solve_rate < HARD_SOLVE_RATE,
    }));
  }

  function levelStats() {
    const toRow = (row, i, name = null) => ({
      levelId: row.id,
      // Levels have no names: "Level 3" by place in the panel list (this query's order).
      name: name ?? (row.id === null ? 'Daily puzzle' : levelLabel(i + 1)),
      published: Boolean(row.published),
      completions: row.completions,
      avgSeconds: row.avg_seconds,
      avgStars: row.avg_stars,
      devices: row.devices,
    });
    const levels = db.prepare(`
      SELECT l.id, l.published, COUNT(e.id) AS completions, AVG(e.seconds) AS avg_seconds,
        AVG(e.stars) AS avg_stars, COUNT(DISTINCT e.device) AS devices
      FROM levels l LEFT JOIN events e ON e.level_id = l.id AND e.type = 'level_completed'
      GROUP BY l.id ORDER BY l.position, l.id`).all().map((row, i) => toRow(row, i));

    const daily = db.prepare(`
      SELECT NULL AS id, 1 AS published, COUNT(*) AS completions,
        AVG(seconds) AS avg_seconds, AVG(stars) AS avg_stars, COUNT(DISTINCT device) AS devices
      FROM events WHERE type = 'level_completed' AND level_number = 0`).get();
    const wordSearch = db.prepare(`
      SELECT NULL AS id, 1 AS published, COUNT(*) AS completions,
        AVG(seconds) AS avg_seconds, AVG(stars) AS avg_stars, COUNT(DISTINCT device) AS devices
      FROM events WHERE type = 'wordsearch_completed'`).get();
    return [
      ...levels,
      ...(daily.completions ? [toRow(daily, -1)] : []),
      ...(wordSearch.completions ? [toRow(wordSearch, -1, 'Daily word search')] : []),
    ];
  }

  /** Headline numbers for the top of the Stats page. */
  function overview() {
    return db.prepare(`SELECT COUNT(*) AS events, COUNT(DISTINCT device) AS devices,
      COUNT(DISTINCT CASE WHEN received_at >= datetime('now', '-7 days') THEN device END) AS devicesWeek,
      MIN(received_at) AS since
      FROM events`).get();
  }

  /**
   * Throws away every recorded event: the Stats page starts from nothing.
   *
   * Questions and levels are untouched — this is the play history, not the
   * content. Returns how many rows went.
   */
  const clear = () => db.prepare('DELETE FROM events').run().changes;

  return { record, prune, questionStats, levelStats, overview, clear };
}
