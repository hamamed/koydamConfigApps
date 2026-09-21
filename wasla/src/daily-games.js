/**
 * The five daily games beside the word search (contract §6): one set per
 * calendar date, the same for everyone.
 *
 *   scramble — five clues, each answer's letters shuffled
 *   bubbles  — one theme's words cut into pieces, all the pieces mixed
 *   groups   — sixteen words hiding four titles of four
 *   wheel    — a handful of letters and the words they spell
 *   guess    — one hidden five-letter word, six tries
 *
 * Scramble, bubbles and groups come from the questions; wheel and guess from
 * the two word lists edited on the Daily games page (src/daily-games-words.js
 * until edited). Every choice comes from a seed made of the date, so every
 * request answers the same for the same date.
 *
 * A game saved for a date in the panel (`daily_game_days`, planned from the
 * automatic pick or typed by hand) always wins. An unsaved game follows the
 * questions and lists, so editing them changes days not yet planned.
 */

import { foldForPlay, letters, normalizeAnswer } from './arabic.js';
import { parseDay } from './daily.js';
import { DEFAULT_GUESS_WORDS, DEFAULT_WHEEL_SETS } from './daily-games-words.js';
import { random, shuffled } from './wordsearch.js';

export const GAME_KINDS = Object.freeze(['scramble', 'bubbles', 'groups', 'wheel', 'guess']);

export const SCRAMBLE_WORDS = 5;
export const SCRAMBLE_LETTERS = Object.freeze([3, 7]);
export const BUBBLE_WORDS = 5;
export const BUBBLE_LETTERS = Object.freeze([4, 8]);
export const GROUP_COUNT = 4;
export const GROUP_SIZE = 4;
export const GROUP_LETTERS = Object.freeze([3, 8]);
export const GUESS_LETTERS = 5;
export const GUESS_TRIES = 6;
export const WHEEL_LETTERS = Object.freeze([3, 7]);
export const WHEEL_MIN_WORDS = 3;
export const WHEEL_MAX_WORDS = 8;
export const LIST_NAMES = Object.freeze(['guess', 'wheel']);
const MAX_LIST_CHARS = 50_000;

const ARABIC_WORD = /^[ء-غف-ي]+$/u;
const inRange = (n, [min, max]) => n >= min && n <= max;
const codePointOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** A different seed per game and date. */
export const seedFor = (day, kind) => (Math.imul(day + 1, 2246822519) ^ Math.imul(GAME_KINDS.indexOf(kind) + 7, 3266489917)) >>> 0;

/** A word as played: bare, then folded (contract §1). */
const played = (raw) => foldForPlay(normalizeAnswer(raw));

/** Letters of `word` shuffled so they never read as the word itself; null when that is impossible. */
export function scrambleLetters(word, rand) {
  const list = letters(word);
  if (new Set(list).size < 2) return null;
  for (let attempt = 0; attempt < 20; attempt++) {
    const mixed = shuffled(list, rand).join('');
    if (mixed !== word) return mixed;
  }
  return [...list.slice(1), list[0]].join('');
}

/**
 * Pieces of two letters, the last taking the odd one: 4 → 2+2, 5 → 2+3,
 * 7 → 2+2+3. Never a single letter, which would fit almost anywhere.
 */
export function splitParts(word) {
  const list = letters(word);
  const parts = [];
  for (let i = 0; i < list.length; i += 2) parts.push(list.slice(i, i + 2).join(''));
  if (parts.length > 1 && letters(parts.at(-1)).length === 1) parts.splice(-2, 2, parts.at(-2) + parts.at(-1));
  return parts;
}

/** Questions grouped by title: `[{ title, words: [{ id, word, display }] }]`, one entry per played word, by title. */
export function titleGroups(questions, [min, max]) {
  const groups = new Map();
  for (const q of questions) {
    const title = String(q.title ?? '').trim();
    const word = played(q.answer);
    if (!title || !inRange(letters(word).length, [min, max])) continue;
    const group = groups.get(title) ?? { title, words: [], seen: new Set() };
    if (group.seen.has(word)) continue;
    group.seen.add(word);
    group.words.push({ id: q.id, word, display: normalizeAnswer(q.answer) });
    groups.set(title, group);
  }
  return [...groups.values()]
    .map(({ title, words }) => ({ title, words }))
    .sort((a, b) => codePointOrder(a.title, b.title));
}

export function buildScramble(questions, seed) {
  const rand = random(seed);
  const seen = new Set();
  const pool = [];
  for (const q of questions) {
    const word = played(q.answer);
    const clue = String(q.clue ?? '').trim();
    if (!clue || seen.has(word) || !inRange(letters(word).length, SCRAMBLE_LETTERS) || new Set(letters(word)).size < 2) continue;
    seen.add(word);
    pool.push({ id: q.id, word, display: normalizeAnswer(q.answer), clue });
  }
  if (pool.length < SCRAMBLE_WORDS) return null;
  const words = shuffled(pool, rand).slice(0, SCRAMBLE_WORDS)
    .sort((a, b) => letters(a.word).length - letters(b.word).length || a.id - b.id)
    .map((w) => ({ ...w, letters: scrambleLetters(w.word, rand) }));
  return { words };
}

export function buildBubbles(groups, day, seed) {
  const themes = groups.filter((g) => g.words.length >= BUBBLE_WORDS);
  if (!themes.length) return null;
  const rand = random(seed);
  // Offset from the word search's rotation, so the two rarely share a theme.
  const theme = themes[(day + 3) % themes.length];
  const words = shuffled(theme.words, rand).slice(0, BUBBLE_WORDS)
    .map((w) => ({ ...w, parts: splitParts(w.word) }));
  return { theme: theme.title, words, bubbles: shuffled(words.flatMap((w) => w.parts), rand) };
}

export function buildGroups(groups, seed) {
  const rand = random(seed);
  const chosen = [];
  const used = new Set();
  for (const group of shuffled(groups.filter((g) => g.words.length >= GROUP_SIZE), rand)) {
    const fresh = shuffled(group.words, rand).filter((w) => !used.has(w.word)).slice(0, GROUP_SIZE);
    if (fresh.length < GROUP_SIZE) continue;
    fresh.forEach((w) => used.add(w.word));
    chosen.push({ title: group.title, words: fresh });
    if (chosen.length === GROUP_COUNT) break;
  }
  if (chosen.length < GROUP_COUNT) return null;
  return { groups: chosen, order: shuffled(chosen.flatMap((g) => g.words.map((w) => w.id)), rand) };
}

/** True when `word` can be spelled from `pool`, each letter used at most as often as it is there. */
export function spelledFrom(word, pool) {
  const counts = new Map();
  for (const ch of letters(pool)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  for (const ch of letters(word)) {
    const left = counts.get(ch) ?? 0;
    if (!left) return false;
    counts.set(ch, left - 1);
  }
  return true;
}

/** `{ words: [{ word, display }], problems: [{ line, text, reason }] }` from the guess list. */
export function parseGuessWords(text) {
  const words = [];
  const problems = [];
  const seen = new Set();
  String(text ?? '').split(/\r?\n/).forEach((raw, index) => {
    const display = normalizeAnswer(raw);
    if (!display) return;
    const word = foldForPlay(display);
    const line = index + 1;
    if (!ARABIC_WORD.test(display)) problems.push({ line, text: raw.trim(), reason: 'only Arabic letters' });
    else if (letters(word).length !== GUESS_LETTERS) problems.push({ line, text: raw.trim(), reason: `${letters(word).length} letters, not ${GUESS_LETTERS}` });
    else if (seen.has(word)) problems.push({ line, text: raw.trim(), reason: 'listed twice' });
    else {
      seen.add(word);
      words.push({ word, display });
    }
  });
  return { words, problems };
}

/** `{ sets: [{ letters, words }], problems }` from the wheel list: `letters: word word …` per line. */
export function parseWheelSets(text) {
  const sets = [];
  const problems = [];
  String(text ?? '').split(/\r?\n/).forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const line = index + 1;
    const [head, tail] = trimmed.split(/[:：]/);
    const pool = played(head);
    const words = [...new Set(String(tail ?? '').split(/[\s،,]+/).map(played).filter(Boolean))];
    const problem = !ARABIC_WORD.test(pool) ? 'the letters must be Arabic letters, then a colon'
      : !inRange(letters(pool).length, [4, WHEEL_LETTERS[1]]) ? `use 4 to ${WHEEL_LETTERS[1]} letters`
        : words.length < WHEEL_MIN_WORDS ? `needs at least ${WHEEL_MIN_WORDS} words`
          : words.length > WHEEL_MAX_WORDS ? `at most ${WHEEL_MAX_WORDS} words`
            : words.find((w) => !ARABIC_WORD.test(w) || letters(w).length < WHEEL_LETTERS[0]) ? 'every word needs 3 or more Arabic letters'
              : words.find((w) => !spelledFrom(w, pool)) ? `“${words.find((w) => !spelledFrom(w, pool))}” cannot be spelled from ${pool}`
                : null;
    if (problem) problems.push({ line, text: trimmed, reason: problem });
    else sets.push({ letters: pool, words });
  });
  return { sets, problems };
}

/** A fixed shuffle, so neighbouring lines of a list are not neighbouring days. */
const rotation = (list, day, salt) => (list.length ? shuffled(list, random(salt))[day % list.length] : null);

export function buildWheel(sets, day, seed) {
  const set = rotation(sets, day, 0x5eed);
  if (!set) return null;
  const words = [...set.words].sort((a, b) => letters(a).length - letters(b).length || codePointOrder(a, b));
  return { letters: scrambleLetters(set.letters, random(seed)) ?? set.letters, words };
}

export function buildGuess(words, day) {
  const pick = rotation(words, day, 0x9e55);
  return pick ? { word: pick.word, display: pick.display, tries: GUESS_TRIES } : null;
}

export function createDailyGames(db, { appConfig }) {
  const DEFAULTS = { guess: DEFAULT_GUESS_WORDS.trim(), wheel: DEFAULT_WHEEL_SETS.trim() };

  const listText = (name) => db.prepare('SELECT body FROM daily_game_lists WHERE name = ?').pluck().get(name) ?? DEFAULTS[name];
  const isEdited = (name) => Boolean(db.prepare('SELECT 1 FROM daily_game_lists WHERE name = ?').get(name));
  const questions = () => db.prepare('SELECT id, answer, clue, trim(IFNULL(title, \'\')) AS title FROM questions ORDER BY id').all();

  /** Both lists with what they parse to, for the panel. */
  function lists() {
    const guess = parseGuessWords(listText('guess'));
    const wheel = parseWheelSets(listText('wheel'));
    return {
      guess: { text: listText('guess'), edited: isEdited('guess'), count: guess.words.length, problems: guess.problems },
      wheel: { text: listText('wheel'), edited: isEdited('wheel'), count: wheel.sets.length, problems: wheel.problems },
    };
  }

  /** Saves a list when every line is usable and at least one entry remains; `{ error, problems }` otherwise. */
  function saveList(name, text) {
    if (!LIST_NAMES.includes(name)) return { error: 'قائمة غير معروفة.' };
    const body = String(text ?? '').trim();
    if (body.length > MAX_LIST_CHARS) return { error: `A list can be at most ${MAX_LIST_CHARS.toLocaleString('en')} characters.` };
    const parsed = name === 'guess' ? parseGuessWords(body) : parseWheelSets(body);
    const count = name === 'guess' ? parsed.words.length : parsed.sets.length;
    if (parsed.problems.length) return { error: `${parsed.problems.length} line(s) need fixing; nothing was saved.`, problems: parsed.problems };
    if (!count) return { error: 'تحتاج القائمة مدخلاً واحداً على الأقل.', problems: [] };
    db.prepare(`INSERT INTO daily_game_lists (name, body) VALUES (?, ?)
      ON CONFLICT(name) DO UPDATE SET body = excluded.body, updated_at = datetime('now')`).run(name, body);
    return { count };
  }

  /** Back to the built-in list. */
  const resetList = (name) => db.prepare('DELETE FROM daily_game_lists WHERE name = ?').run(name).changes > 0;

  /** What each game would be on a date with nothing saved for it. */
  function automatic(date) {
    const parsed = parseDay(date);
    if (!parsed) return null;
    const { day } = parsed;
    const rows = questions();
    return {
      scramble: buildScramble(rows, seedFor(day, 'scramble')),
      bubbles: buildBubbles(titleGroups(rows, BUBBLE_LETTERS), day, seedFor(day, 'bubbles')),
      groups: buildGroups(titleGroups(rows, GROUP_LETTERS), seedFor(day, 'groups')),
      wheel: buildWheel(parseWheelSets(listText('wheel')).sets, day, seedFor(day, 'wheel')),
      guess: buildGuess(parseGuessWords(listText('guess')).words, day),
    };
  }

  /**
   * Another pick for one game on a date.
   *
   * The automatic pick is a pure function of the date, so asking for "a
   * different one" needs a number from outside it: `nonce` shifts both the
   * rotation (which words the day lands on) and the seed (how they are
   * scrambled). The caller saves whatever comes back, so the nonce itself
   * never has to be remembered.
   */
  function pickAgain(date, kind, nonce = 1) {
    const parsed = parseDay(date);
    if (!parsed || !GAME_KINDS.includes(kind)) return null;
    const step = Number.isFinite(Number(nonce)) ? Math.trunc(Number(nonce)) : 1;
    const day = parsed.day + step;
    const seed = (seedFor(parsed.day, kind) ^ Math.imul(step + 1, 2654435761)) >>> 0;
    const rows = questions();
    switch (kind) {
      case 'scramble': return buildScramble(rows, seed);
      case 'bubbles': return buildBubbles(titleGroups(rows, BUBBLE_LETTERS), day, seed);
      case 'groups': return buildGroups(titleGroups(rows, GROUP_LETTERS), seed);
      case 'wheel': return buildWheel(parseWheelSets(listText('wheel')).sets, day, seed);
      case 'guess': return buildGuess(parseGuessWords(listText('guess')).words, day);
      default: return null;
    }
  }

  // ── Days planned in the panel ─────────────────────────────────────────────

  /** `{ kind: { game, source, updatedAt } }` saved for a date (absent kinds are automatic). */
  function saved(date) {
    const out = {};
    for (const row of db.prepare('SELECT kind, game, source, updated_at FROM daily_game_days WHERE date = ?').all(date)) {
      try {
        out[row.kind] = { game: JSON.parse(row.game), source: row.source, updatedAt: row.updated_at };
      } catch (err) {
        console.error(`daily_game_days ${date}/${row.kind}: unreadable JSON, serving the automatic game`, err);
      }
    }
    return out;
  }

  /** Fixes one game for a date. `source` is "typed" for words written in the panel. */
  function saveGame(date, kind, game, source = 'typed') {
    if (!parseDay(date) || !GAME_KINDS.includes(kind) || !game) return { error: 'تاريخ أو لعبة غير معروفة.' };
    db.prepare(`INSERT INTO daily_game_days (date, kind, game, source) VALUES (?, ?, ?, ?)
      ON CONFLICT(date, kind) DO UPDATE SET game = excluded.game, source = excluded.source, updated_at = datetime('now')`)
      .run(date, kind, JSON.stringify(game), source);
    return {};
  }

  /** Back to automatic for that game and date. */
  const resetGame = (date, kind) => db.prepare('DELETE FROM daily_game_days WHERE date = ? AND kind = ?').run(date, kind).changes > 0;

  /** Every game on a date back to automatic; the number of rows that went. */
  const clearDay = (date) => db.prepare('DELETE FROM daily_game_days WHERE date = ?').run(date).changes;

  /**
   * Puts the games of `from` on `date` — what players actually got (or would
   * get) that day, planned or automatic, so a good day can be run again.
   */
  function copyDay(date, from) {
    if (!parseDay(date) || !parseDay(from)) return { error: 'هذا ليس تاريخاً صحيحاً.' };
    if (date === from) return { error: 'اختر يوماً آخر للنسخ منه.' };
    const auto = automatic(from) ?? {};
    const have = saved(from);
    let copied = 0;
    db.transaction(() => {
      for (const kind of GAME_KINDS) {
        const game = have[kind]?.game ?? auto[kind];
        if (!game) continue;
        saveGame(date, kind, game, 'auto');
        copied++;
      }
    })();
    return { copied };
  }

  /** Saves the automatic pick of every game not yet saved for the date, so later edits to questions or lists leave it alone. */
  function freeze(date) {
    const auto = automatic(date);
    if (!auto) return { added: 0 };
    const have = saved(date);
    let added = 0;
    db.transaction(() => {
      for (const kind of GAME_KINDS) {
        if (have[kind] || !auto[kind]) continue;
        saveGame(date, kind, auto[kind], 'auto');
        added++;
      }
    })();
    return { added };
  }

  /** For the calendar: which games are saved on each date in [from, to]. `{ date: { kind: source } }` */
  function plannedBetween(from, to) {
    const out = {};
    for (const row of db.prepare('SELECT date, kind, source FROM daily_game_days WHERE date >= ? AND date <= ?').all(from, to)) {
      (out[row.date] ??= {})[row.kind] = row.source;
    }
    return out;
  }

  /** The set the API sends for a date — saved games over the automatic ones — or null for a bad date or when no game can be built. */
  function forDate(date) {
    const parsed = parseDay(date);
    if (!parsed) return null;
    const config = appConfig.get();
    const auto = automatic(parsed.date);
    const fixed = saved(parsed.date);
    const games = Object.fromEntries(GAME_KINDS.map((kind) => [kind, fixed[kind]?.game ?? auto[kind]]));
    if (Object.values(games).every((g) => g === null)) return null;
    return { date: parsed.date, coins: config.dailyGameCoins, allBonus: config.dailyAllGamesBonus, ...games };
  }

  return { forDate, automatic, pickAgain, saved, saveGame, resetGame, clearDay, copyDay, freeze, plannedBetween, lists, saveList, resetList };
}
