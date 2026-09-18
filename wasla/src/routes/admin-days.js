import { dayToDate, parseDay, todayUtc } from '../daily.js';
import { EDITORS } from '../daily-game-editor.js';
import { GAME_KINDS } from '../daily-games.js';
import { eventFor, eventLabel } from '../seasonal-events.js';
import { ARABIC_WEEKDAYS, previewOf } from '../wordsearch-editor.js';
import { WEEKDAY_NAMES, weekdayOf } from '../wordsearch-daily.js';
import { sourceOf } from '../wordsearch-schedule.js';

export const PLAN_CHOICES = Object.freeze([7, 14, 30]);
const CALENDAR_DAYS = 30;

export const GAME_LABELS = Object.freeze({
  scramble: { en: 'Scramble', ar: 'رتّب الحروف', icon: 'shuffle', hint: 'One word per line: answer | clue (3–8 words).' },
  bubbles: { en: 'Bubbles', ar: 'فقاعات الكلمات', icon: 'circle-dot', hint: 'First line the theme, then one word per line (3–8 words of 3–8 letters).' },
  groups: { en: 'Groups', ar: 'صِل المجموعات', icon: 'layout-grid', hint: 'Four lines: title: word، word، word، word' },
  wheel: { en: 'Wheel', ar: 'عجلة الحروف', icon: 'circle-dashed', hint: 'One line: letters: word word word (every word spelled from the letters).' },
  guess: { en: 'Guess', ar: 'خمّن الكلمة', icon: 'square-asterisk', hint: 'One word of exactly 5 letters.' },
});

/**
 * The daily puzzle, one page per day: the word search and the five games,
 * each planned (saved) or automatic, editable as plain text on the day's page.
 * "Plan" saves the automatic pick of everything not yet planned, so later edits
 * to questions or lists no longer move those days.
 */
export function registerDays(router, { dailyGames, wordSearch, wordSearchDays }) {
  const isPast = (date) => date < todayUtc();

  /** Plans the word search and every game on `date` that is not planned yet. `{ wordSearch, games }` */
  function planDate(date, previousTheme) {
    let theme = wordSearchDays.get(date)?.theme ?? null;
    let wordSearchAdded = false;
    if (!theme) {
      const pick = wordSearch.automaticPick(date, wordSearch.playable(), { avoid: previousTheme });
      if (pick) {
        const board = { theme: pick.theme, size: pick.size, rows: pick.board.rows, words: pick.board.words };
        const saved = wordSearchDays.save(date, { theme: pick.theme, size: pick.size, words: pick.board.words, seed: pick.seed, board, source: sourceOf(pick) });
        if (!saved.error) {
          theme = pick.theme;
          wordSearchAdded = true;
        }
      }
    }
    return { theme, wordSearchAdded, gamesAdded: dailyGames.freeze(date).added };
  }

  router.get('/days', (req, res) => {
    const start = parseDay(String(req.query.from ?? ''))?.day ?? parseDay(todayUtc()).day;
    const from = dayToDate(start);
    const to = dayToDate(start + CALENDAR_DAYS - 1);
    const games = dailyGames.plannedBetween(from, to);
    const days = Array.from({ length: CALENDAR_DAYS }, (_, i) => {
      const date = dayToDate(start + i);
      const saved = wordSearchDays.get(date);
      return {
        date,
        weekday: WEEKDAY_NAMES[weekdayOf(start + i)].slice(0, 3),
        weekdayAr: ARABIC_WEEKDAYS[weekdayOf(start + i)],
        isToday: date === todayUtc(),
        isPast: isPast(date),
        event: eventLabel(eventFor(date)),
        wordSearch: saved ? { theme: saved.theme, source: saved.source } : null,
        games: games[date] ?? {},
      };
    });
    const planned = days.filter((d) => d.wordSearch && GAME_KINDS.every((k) => d.games[k])).length;
    res.render('days', {
      title: 'Daily',
      days,
      planned,
      kinds: GAME_KINDS,
      labels: GAME_LABELS,
      planChoices: PLAN_CHOICES,
      previous: dayToDate(start - CALENDAR_DAYS),
      next: dayToDate(start + CALENDAR_DAYS),
      isCurrent: from === todayUtc(),
    });
  });

  router.post('/days/plan', (req, res) => {
    const count = Number(req.body.count);
    if (!PLAN_CHOICES.includes(count)) {
      req.flash('danger', `Plan ${PLAN_CHOICES.join(', ')} days at a time.`);
      return res.redirect('/admin/days');
    }
    const start = parseDay(todayUtc()).day;
    let previous = wordSearchDays.get(dayToDate(start - 1))?.theme ?? null;
    let wordSearchAdded = 0;
    let gamesAdded = 0;
    for (let i = 0; i < count; i++) {
      const result = planDate(dayToDate(start + i), previous);
      previous = result.theme;
      wordSearchAdded += result.wordSearchAdded ? 1 : 0;
      gamesAdded += result.gamesAdded;
    }
    req.flash('success', wordSearchAdded || gamesAdded
      ? `Planned the next ${count} days: ${wordSearchAdded} word search board(s) and ${gamesAdded} game(s) saved. Open any day to change it.`
      : `The next ${count} days were already planned.`);
    res.redirect('/admin/days');
  });

  /** The date from the URL, or a redirect (and null). */
  function dateParam(req, res) {
    const parsed = parseDay(req.params.date);
    if (!parsed) {
      req.flash('danger', 'That is not a calendar date.');
      res.redirect('/admin/days');
      return null;
    }
    return parsed;
  }

  function renderDay(res, date, { drafts = {}, errors = {} } = {}) {
    const { day } = parseDay(date);
    const set = dailyGames.forDate(date);
    const saved = dailyGames.saved(date);
    const games = GAME_KINDS.map((kind) => {
      const game = set?.[kind] ?? null;
      return {
        kind,
        label: GAME_LABELS[kind],
        game,
        source: saved[kind]?.source ?? null,
        updatedAt: saved[kind]?.updatedAt ?? null,
        text: drafts[kind] ?? EDITORS[kind].toText(game),
        errors: errors[kind] ?? [],
        isOpen: Boolean(errors[kind]?.length),
      };
    });
    const wsDay = wordSearchDays.get(date);
    const board = wordSearchDays.boardFor(date);
    res.render('day', {
      title: `Daily · ${date}`,
      date,
      event: eventLabel(eventFor(date)),
      weekday: WEEKDAY_NAMES[weekdayOf(day)],
      weekdayAr: ARABIC_WEEKDAYS[weekdayOf(day)],
      previous: dayToDate(day - 1),
      next: dayToDate(day + 1),
      past: isPast(date),
      wordSearch: { day: wsDay, board: board && previewOf(board) },
      games,
      allPlanned: Boolean(wsDay) && games.every((g) => g.source || !g.game),
    });
  }

  router.get('/days/:date', (req, res) => {
    const parsed = dateParam(req, res);
    if (parsed) renderDay(res, parsed.date);
  });

  router.post('/days/:date/plan', (req, res) => {
    const parsed = dateParam(req, res);
    if (!parsed) return;
    if (isPast(parsed.date)) {
      req.flash('danger', 'Past days cannot change.');
      return res.redirect(`/admin/days/${parsed.date}`);
    }
    const previous = wordSearchDays.get(dayToDate(parsed.day - 1))?.theme ?? null;
    const result = planDate(parsed.date, previous);
    req.flash('success', `Saved ${parsed.date}: ${result.wordSearchAdded ? 'the word search and ' : ''}${result.gamesAdded} game(s). Players get exactly this.`);
    res.redirect(`/admin/days/${parsed.date}`);
  });

  router.post('/days/:date/games/:kind', (req, res) => {
    const parsed = dateParam(req, res);
    if (!parsed) return;
    const { kind } = req.params;
    if (!GAME_KINDS.includes(kind)) return res.redirect(`/admin/days/${parsed.date}`);
    if (isPast(parsed.date)) {
      req.flash('danger', 'Past days cannot change.');
      return res.redirect(`/admin/days/${parsed.date}`);
    }
    const text = String(req.body.text ?? '');
    const read = EDITORS[kind].read(text);
    if (read.errors) {
      res.locals.flash = { type: 'danger', message: `${GAME_LABELS[kind].en}: fix the lines below; nothing was saved.` };
      return renderDay(res, parsed.date, { drafts: { [kind]: text }, errors: { [kind]: read.errors } });
    }
    dailyGames.saveGame(parsed.date, kind, read.game, 'typed');
    req.flash('success', `${GAME_LABELS[kind].en} saved for ${parsed.date}.`);
    res.redirect(`/admin/days/${parsed.date}#${kind}`);
  });

  router.post('/days/:date/games/:kind/auto', (req, res) => {
    const parsed = dateParam(req, res);
    if (!parsed) return;
    const { kind } = req.params;
    if (GAME_KINDS.includes(kind) && !isPast(parsed.date) && dailyGames.resetGame(parsed.date, kind)) {
      req.flash('success', `${GAME_LABELS[kind].en} on ${parsed.date} is automatic again.`);
    }
    res.redirect(`/admin/days/${parsed.date}#${kind}`);
  });
}
