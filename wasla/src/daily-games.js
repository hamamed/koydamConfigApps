/**
 * The daily games that are not the word search (contract §6, §9): one set per
 * calendar date, the same for everyone.
 *
 *   bubbles — a picture and its words, cut into pieces and mixed
 *   wheel   — a handful of letters and the words they spell
 *   guess   — two hidden five-letter words at once, eight tries for both
 *   connect — a board of letters, and the answers spelled out of it: a
 *             title's questions, a picture's words, or a proverb in emoji
 *   picture — one picture and the five words of ten that belong to it
 *
 * فقاعات الكلمات is played on the pictures written in the panel
 * (src/bubble-pictures.js), and falls back to a theme from the question bank
 * when no picture is published for that date. The other two come from the word
 * lists edited on the Daily games page (src/daily-games-words.js until edited). Every choice comes from a seed made
 * of the date, so every request answers the same for the same date.
 *
 * A game saved for a date in the panel (`daily_game_days`, planned from the
 * automatic pick or typed by hand) always wins. An unsaved game follows the
 * lists, so editing them changes days not yet planned.
 */

import { foldForPlay, letters, normalizeAnswer } from './arabic.js';
import { MIN_ROUND_WORDS } from './bubble-pictures.js';
import { parseDay } from './daily.js';
import { kindForDay, schedule as weekSchedule, weekdayOf } from './daily-schedule.js';
import { connectForDate } from './connect.js';
import { ladderFor } from './daily-ladder.js';
import { DEFAULT_GUESS_WORDS, DEFAULT_WHEEL_SETS } from './daily-games-words.js';
import { random, shuffled } from './wordsearch.js';

export const GAME_KINDS = Object.freeze(['bubbles', 'wheel', 'guess', 'connect']);

/* How big each game aims to be, and the least it may be built at. */
export const BUBBLE_WORDS = 8;
export const BUBBLE_MIN_WORDS = 5;
export const BUBBLE_LETTERS = Object.freeze([4, 10]);
export const GUESS_LETTERS = 5;
export const GUESS_WORDS = 2;
export const GUESS_TRIES = 8;
export const WHEEL_LETTERS = Object.freeze([3, 7]);
export const WHEEL_MIN_WORDS = 3;
export const WHEEL_MAX_WORDS = 14;
/** A wheel set worth a whole day: the picker takes one of these when the list has any. */
export const WHEEL_RICH_WORDS = 6;
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

/**
 * A picture round as the app plays it: the picture, and its words cut into
 * pieces with every piece on the board at once.
 */
export function buildPictureBubbles(round, seed) {
  if (!round?.words?.length) return null;
  const rand = random(seed);
  // A word is cut into pieces of two, so the short ones — which وصّل الحروف
  // spells letter by letter — would come back whole and give themselves away.
  const words = round.words
    .map((raw, index) => {
      const word = played(raw);
      return { id: (round.id ?? 0) * 100 + index, word, display: normalizeAnswer(raw), parts: splitParts(word) };
    })
    .filter((word) => letters(word.word).length >= BUBBLE_LETTERS[0]);
  if (words.length < MIN_ROUND_WORDS) return null;
  return {
    theme: round.title,
    image: round.image ?? null,
    words,
    bubbles: shuffled(words.flatMap((w) => w.parts), rand),
  };
}

export function buildBubbles(groups, day, seed) {
  // Themes deep enough for a full round when there are any, else whatever can
  // still make a short one — a day with a thin bank plays small, not empty.
  const deep = groups.filter((g) => g.words.length >= BUBBLE_WORDS);
  const themes = deep.length ? deep : groups.filter((g) => g.words.length >= BUBBLE_MIN_WORDS);
  if (!themes.length) return null;
  const rand = random(seed);
  // Offset from the word search's rotation, so the two rarely share a theme.
  const theme = themes[(day + 3) % themes.length];
  const words = shuffled(theme.words, rand).slice(0, BUBBLE_WORDS)
    .map((w) => ({ ...w, parts: splitParts(w.word) }));
  return { theme: theme.title, words, bubbles: shuffled(words.flatMap((w) => w.parts), rand) };
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
  // A three-word wheel is over in seconds; when the list holds fuller sets the
  // day takes one of those, and only falls back to the rest when it does not.
  const rich = sets.filter((s) => s.words.length >= WHEEL_RICH_WORDS);
  const set = rotation(rich.length ? rich : sets, day, 0x5eed);
  if (!set) return null;
  const words = [...set.words].sort((a, b) => letters(a).length - letters(b).length || codePointOrder(a, b));
  return { letters: scrambleLetters(set.letters, random(seed)) ?? set.letters, words };
}

/**
 * Two hidden words side by side, eight tries for both: every guess is marked on
 * each board at once, so a letter ruled out on one still has to earn its place
 * on the other.
 *
 * `word` and `display` repeat the first of them, which is what app builds from
 * before the week of one game a day read — they get a plain single-word round.
 */
export function buildGuess(words, day) {
  const picks = [];
  for (let i = 0; i < GUESS_WORDS && picks.length < words.length; i++) {
    const pick = rotation(words.filter((w) => !picks.some((p) => p.word === w.word)), day, 0x9e55 + i * 0x2f1b);
    if (pick) picks.push(pick);
  }
  if (!picks.length) return null;
  return {
    words: picks.map(({ word, display }) => ({ word, display })),
    word: picks[0].word,
    display: picks[0].display,
    tries: GUESS_TRIES,
  };
}

/* ── Friday's marathon ─────────────────────────────────────────────────────
 *
 * Every game in one run, each cut down to a sprint: the day is not about
 * finishing one puzzle well but about getting through all six. The rounds are
 * the same shapes the app already plays, so nothing new has to be drawn — only
 * shorter, and with no second chances between them.
 */

export const MARATHON_ROUNDS = Object.freeze(['bubbles', 'connect', 'wheel', 'guess', 'wordsearch']);
export const MARATHON_SIZES = Object.freeze({ bubbles: 4, wheel: 6, guess: 1, board: 7 });
export const MARATHON_GUESS_TRIES = 5;

/** The same game, cut to marathon length; null stays null. */
export function trimForMarathon(kind, game, rand) {
  if (!game) return null;
  switch (kind) {
    case 'bubbles': {
      const words = game.words.slice(0, MARATHON_SIZES.bubbles);
      return { ...game, words, bubbles: shuffled(words.flatMap((w) => w.parts), rand) };
    }
    case 'wheel':
      return { letters: game.letters, words: game.words.slice(0, MARATHON_SIZES.wheel) };
    // connect is not cut: its board is its answers letter for letter, so
    // dropping one would leave boxes belonging to nothing. Its boards are
    // short enough for a sprint as they are.
    case 'guess': {
      const words = game.words.slice(0, MARATHON_SIZES.guess);
      return { words, word: words[0].word, display: words[0].display, tries: MARATHON_GUESS_TRIES };
    }
    default:
      return game;
  }
}

export function createDailyGames(db, { appConfig, wordSearch = null, wordSearchDays = null, pictures = null, lab = null }) {
  const DEFAULTS = { guess: DEFAULT_GUESS_WORDS.trim(), wheel: DEFAULT_WHEEL_SETS.trim() };

  const questions = () => db.prepare(`SELECT id, answer, IFNULL(clue, '') AS clue, IFNULL(emoji, '') AS emoji,
    trim(IFNULL(title, '')) AS title FROM questions ORDER BY id`).all();
  const listText = (name) => db.prepare('SELECT body FROM daily_game_lists WHERE name = ?').pluck().get(name) ?? DEFAULTS[name];
  const isEdited = (name) => Boolean(db.prepare('SELECT 1 FROM daily_game_lists WHERE name = ?').get(name));

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
    return {
      bubbles: buildPictureBubbles(pictures?.forDate(parsed.date, 0, { cutAt: BUBBLE_LETTERS[0] }), seedFor(day, 'bubbles'))
        ?? buildBubbles(titleGroups(questions(), BUBBLE_LETTERS), day, seedFor(day, 'bubbles')),
      wheel: buildWheel(parseWheelSets(listText('wheel')).sets, day, seedFor(day, 'wheel')),
      guess: buildGuess(parseGuessWords(listText('guess')).words, day),
      connect: connectForDate(questions(), parsed.date, { pictures, riddles: lab?.riddles() ?? [] }),
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
    switch (kind) {
      case 'bubbles': return buildPictureBubbles(pictures?.forDate(parsed.date, step, { cutAt: BUBBLE_LETTERS[0] }), seed)
        ?? buildBubbles(titleGroups(questions(), BUBBLE_LETTERS), day, seed);
      case 'wheel': return buildWheel(parseWheelSets(listText('wheel')).sets, day, seed);
      case 'guess': return buildGuess(parseGuessWords(listText('guess')).words, day);
      case 'connect': return connectForDate(questions(), parsed.date,
        { nonce: step, pictures, riddles: lab?.riddles() ?? [] });
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

  /** The games of a date as players get them: what the panel saved, else the automatic pick. */
  function gamesFor(date) {
    const auto = automatic(date) ?? {};
    const fixed = saved(date);
    return Object.fromEntries(GAME_KINDS.map((kind) => [kind, fixed[kind]?.game ?? auto[kind] ?? null]));
  }

  /**
   * Friday's run: the date's own games, each cut to a sprint, plus a small
   * board when the word search can build one. Any date can be asked, so the
   * panel can preview a Friday before it arrives.
   */
  function marathonFor(date) {
    const parsed = parseDay(date);
    if (!parsed) return null;
    const rand = random(seedFor(parsed.day, 'scramble') ^ 0x4d41524e);
    const games = gamesFor(parsed.date);
    const rounds = [];
    for (const kind of MARATHON_ROUNDS) {
      if (kind === 'wordsearch') {
        const pick = wordSearch?.marathonBoard?.(parsed.date, MARATHON_SIZES.board);
        if (pick) rounds.push({ kind, game: pick });
        continue;
      }
      const game = trimForMarathon(kind, games[kind], rand);
      if (game) rounds.push({ kind, game });
    }
    if (rounds.length < 2) return null;
    return { rounds, bonus: appConfig.get().dailyAllGamesBonus };
  }

  /**
   * The set the API sends for a date — null for a bad date or when no game can
   * be built at all.
   *
   * `kind` is the game of that weekday, the only one that pays; the others are
   * sent all the same, for the archive. App builds from before the schedule
   * read the five games and ignore the rest, so they keep working.
   */
  function forDate(date) {
    const parsed = parseDay(date);
    if (!parsed) return null;
    const config = appConfig.get();
    const games = gamesFor(parsed.date);
    const kind = kindForDay(parsed.day);
    const marathon = kind === 'marathon' ? marathonFor(parsed.date) : null;
    if (Object.values(games).every((g) => g === null) && !marathon) return null;
    // The board of the day is a game like any other rung of the ladder.
    const board = wordSearch ? { wordsearch: wordSearchDays?.boardFor?.(parsed.date) ?? wordSearch.forDate(parsed.date) } : {};
    return {
      date: parsed.date,
      kind,
      weekday: weekdayOf(parsed.day),
      schedule: weekSchedule(),
      coins: config.dailyGameCoins,
      allBonus: config.dailyAllGamesBonus,
      ladder: ladderFor(parsed.date, {
        games: { ...games, ...board },
        coins: config.dailyGameCoins,
        bonus: config.dailyAllGamesBonus,
      }),
      ...games,
      ...(marathon ? { marathon } : {}),
    };
  }

  return { forDate, automatic, marathonFor, pickAgain, saved, saveGame, resetGame, clearDay, copyDay, freeze, plannedBetween, lists, saveList, resetList };
}
