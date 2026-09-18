import { dayToDate, parseDay, todayUtc } from '../daily.js';
import {
  ARABIC_WEEKDAYS, composeDay, CUSTOM_WORD_ID_BASE, defaultWordCount, newSeed, previewOf,
  readCustomWords, readSeed, readSize, readThemeName,
} from '../wordsearch-editor.js';
import { LOW_DAYS_AHEAD } from '../wordsearch-schedule.js';
import { MAX_BOARD_WORDS, MIN_THEME_WORDS, sizeForDay, WEEKDAY_NAMES, weekdayOf } from '../wordsearch-daily.js';
import { MAX_SIZE, MIN_SIZE } from '../wordsearch.js';

/** The "Add days" buttons. */
export const ADD_DAY_CHOICES = Object.freeze([7, 14, 30]);
const PAST_DAYS_SHOWN = 60;

const weekdays = (date) => {
  const index = weekdayOf(parseDay(date).day);
  return { weekday: WEEKDAY_NAMES[index], weekdayAr: ARABIC_WEEKDAYS[index] };
};

const asList = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

/**
 * The daily puzzle — the word search — planned per date. The schedule lists
 * stored boards; "Add days" plans more from the rotation; a day's editor picks
 * a theme's words or takes typed ones, previews the board and freezes it.
 */
export function registerDaily(router, { wordSearch, wordSearchDays }) {
  /** Themes offered in the editor: every eligible one, plus a saved day's theme that no longer is. */
  function themeOptions(day) {
    const eligible = wordSearch.themes().filter((t) => t.eligible);
    const options = eligible.map((t) => ({ title: t.title, words: t.words, excluded: t.excluded, stale: false }));
    if (day?.source === 'theme' && !options.some((t) => t.title === day.theme)) {
      options.unshift({ title: day.theme, words: day.words, excluded: false, stale: true });
    }
    return options;
  }

  /** The editor's inputs, from a saved day, the automatic pick, or nothing. */
  function initialState(date, day) {
    if (day) {
      return {
        source: day.source,
        themeTitle: day.source === 'theme' ? day.theme : '',
        wordIds: day.source === 'theme' ? day.words.map((w) => w.id) : null,
        customTheme: day.source === 'custom' ? day.theme : '',
        customWords: day.source === 'custom' ? day.words.map((w) => w.display).join('\n') : '',
        size: day.size,
        seed: day.seed,
      };
    }
    const pick = wordSearch.automaticPick(date);
    // A seasonal event's theme is no title's: it opens as typed words.
    const isEvent = Boolean(pick?.event);
    return {
      source: pick && !isEvent ? 'theme' : 'custom',
      themeTitle: pick && !isEvent ? pick.theme : '',
      wordIds: pick && !isEvent ? pick.board.words.map((w) => w.id) : null,
      customTheme: isEvent ? pick.theme : '',
      customWords: isEvent ? pick.board.words.map((w) => w.display).join('\n') : '',
      size: pick?.size ?? sizeForDay(parseDay(date).day),
      seed: pick?.seed ?? newSeed(),
    };
  }

  /** The editor's inputs from a posted form. `wordIds` is null when no box was ticked. */
  function stateFromBody(body, date) {
    const ids = asList(body.wordIds).map(Number).filter(Number.isInteger);
    return {
      source: body.source === 'custom' ? 'custom' : 'theme',
      themeTitle: String(body.themeTitle ?? ''),
      wordIds: ids.length ? ids : null,
      customTheme: String(body.customTheme ?? ''),
      customWords: String(body.customWords ?? ''),
      size: readSize(body.size) ?? sizeForDay(parseDay(date).day),
      seed: readSeed(body.seed) ?? newSeed(),
    };
  }

  /** The words a theme ticks when nothing is ticked yet: those that fit, up to the size's usual count. */
  function defaultTicks(theme, size) {
    const fit = theme.words.filter((w) => [...w.word].length <= size);
    return (fit.length >= MIN_THEME_WORDS ? fit : theme.words).slice(0, defaultWordCount(size)).map((w) => w.id);
  }

  /** `{ theme, words, problems }` for the chosen source. */
  function wordsFor(state, options) {
    if (state.source === 'custom') {
      const name = readThemeName(state.customTheme);
      const { words, errors } = readCustomWords(state.customWords);
      return { theme: name.theme ?? '', words, problems: [...(name.error ? [name.error] : []), ...errors] };
    }
    const theme = options.find((t) => t.title === state.themeTitle);
    if (!theme) return { theme: '', words: [], problems: ['Choose a theme.'] };
    const ticked = new Set(state.wordIds ?? defaultTicks(theme, state.size));
    return { theme: theme.title, words: theme.words.filter((w) => ticked.has(w.id)), problems: [] };
  }

  /** Everything the editor view and its live preview need. */
  function editorModel(date, state, day, { useSaved = false } = {}) {
    const options = themeOptions(day);
    const { theme, words, problems } = wordsFor(state, options);
    const composed = useSaved && day
      ? { board: day.board, dropped: [], problems: [], canSave: true }
      : composeDay({ theme, words, size: state.size, seed: state.seed, problems });
    const groups = options.map((t) => ({
      ...t,
      selected: state.source === 'theme' && t.title === state.themeTitle,
      ticked: new Set(t.title === state.themeTitle && state.wordIds ? state.wordIds : defaultTicks(t, state.size)),
    }));
    return {
      date,
      ...weekdays(date),
      today: todayUtc(),
      day,
      state,
      groups,
      weekdaySize: sizeForDay(parseDay(date).day),
      sizes: Array.from({ length: MAX_SIZE - MIN_SIZE + 1 }, (_, i) => MIN_SIZE + i),
      composed: { ...composed, board: composed.board && previewOf(composed.board) },
      customBase: CUSTOM_WORD_ID_BASE,
      minWords: MIN_THEME_WORDS,
      maxWords: MAX_BOARD_WORDS,
    };
  }

  const isPast = (date) => date < todayUtc();

  /** Resolves `:date`, or answers with a redirect and returns null. */
  function dateParam(req, res) {
    const parsed = parseDay(req.params.date);
    if (!parsed) {
      req.flash('danger', 'That is not a calendar date.');
      res.redirect('/admin/daily');
      return null;
    }
    return parsed.date;
  }

  // ── Schedule ──────────────────────────────────────────────────────────────

  router.get('/daily', (_req, res) => {
    const today = todayUtc();
    const withWeekday = (d) => ({ ...d, ...weekdays(d.date), wordCount: d.board.words.length });
    const todayBoard = wordSearchDays.boardFor(today);
    res.render('daily', {
      title: 'Daily puzzle',
      today,
      summary: wordSearchDays.summary(today),
      todayTheme: todayBoard?.theme ?? null,
      upcoming: wordSearchDays.fromDate(today).map(withWeekday),
      past: wordSearchDays.beforeDate(today, PAST_DAYS_SHOWN).map(withWeekday),
      playableCount: wordSearch.playable().length,
      addChoices: ADD_DAY_CHOICES,
      lowDays: LOW_DAYS_AHEAD,
    });
  });

  router.post('/daily/add', (req, res) => {
    const count = Number(req.body.days);
    if (!ADD_DAY_CHOICES.includes(count)) {
      req.flash('danger', `Add ${ADD_DAY_CHOICES.join(', ')} days at a time.`);
      return res.redirect('/admin/daily');
    }
    const result = wordSearchDays.addDays(count, todayUtc());
    if (result.error) {
      req.flash('danger', result.error);
    } else if (!result.added.length) {
      req.flash('danger', `No day was added: no theme can make a board (${result.from} → ${result.to}). Add questions to a theme on the Word themes page, or plan a day with typed words.`);
    } else {
      const skipped = result.skipped.length
        ? ` Skipped ${result.skipped.length} (no theme fits, they stay automatic): ${result.skipped.join(', ')}.`
        : '';
      req.flash(result.skipped.length ? 'warning' : 'success',
        `Added ${result.added.length} day${result.added.length === 1 ? '' : 's'}: ${result.added[0].date} → ${result.added.at(-1).date}.${skipped}`);
    }
    res.redirect('/admin/daily');
  });

  // The date picker on the schedule: plan (or edit) any date from today on.
  router.get('/daily/plan', (req, res) => {
    const parsed = parseDay(String(req.query.date ?? ''));
    if (!parsed) {
      req.flash('danger', 'Pick a date to plan.');
      return res.redirect('/admin/daily');
    }
    res.redirect(`/admin/daily/${parsed.date}/edit`);
  });

  // ── One day ───────────────────────────────────────────────────────────────

  router.get('/daily/:date', (req, res) => {
    const date = dateParam(req, res);
    if (!date) return;
    const day = wordSearchDays.get(date);
    const board = wordSearchDays.boardFor(date);
    const { day: dayNumber } = parseDay(date);
    res.render('daily-day', {
      title: `Daily puzzle ${date}`,
      date,
      ...weekdays(date),
      today: todayUtc(),
      past: isPast(date),
      day,
      board: board && previewOf(board),
      coins: board?.coins ?? null,
      weekdaySize: sizeForDay(dayNumber),
      previous: dayToDate(dayNumber - 1),
      next: dayToDate(dayNumber + 1),
      customBase: CUSTOM_WORD_ID_BASE,
    });
  });

  router.get('/daily/:date/edit', (req, res) => {
    const date = dateParam(req, res);
    if (!date) return;
    if (isPast(date)) {
      req.flash('warning', 'Past days are read-only.');
      return res.redirect(`/admin/daily/${date}`);
    }
    const day = wordSearchDays.get(date);
    res.render('daily-edit', {
      title: `Plan ${date}`,
      ...editorModel(date, initialState(date, day), day, { useSaved: Boolean(day) }),
    });
  });

  // Without JavaScript, Preview and Shuffle post here too; Save stores the board.
  router.post('/daily/:date/edit', (req, res) => {
    const date = dateParam(req, res);
    if (!date) return;
    if (isPast(date)) {
      req.flash('warning', 'Past days are read-only.');
      return res.redirect(`/admin/daily/${date}`);
    }
    const day = wordSearchDays.get(date);
    const action = String(req.body.action ?? 'preview');
    const state = stateFromBody(req.body, date);
    const model = editorModel(date, action === 'shuffle' ? { ...state, seed: newSeed() } : state, day);

    if (action !== 'save') return res.render('daily-edit', { title: `Plan ${date}`, ...model });

    const { composed } = model;
    if (!composed.canSave) {
      return res.status(422).render('daily-edit', { title: `Plan ${date}`, ...model, saveFailed: true });
    }
    const { theme, words } = wordsFor(state, themeOptions(day));
    const board = composeDay({ theme, words, size: state.size, seed: state.seed }).board;
    const result = wordSearchDays.save(date, { theme, size: state.size, words, seed: state.seed, board, source: state.source });
    if (result.error) {
      return res.status(422).render('daily-edit', { title: `Plan ${date}`, ...model, saveFailed: true, saveError: result.error });
    }
    req.flash('success', `Saved the puzzle for ${date}: “${theme}”, ${state.size} × ${state.size}, ${board.words.length} words.`);
    res.redirect(`/admin/days/${date}#wordsearch`);
  });

  // The live preview: the same composition as Save, rendered as the preview panel.
  router.post('/daily/:date/preview', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const parsed = parseDay(req.params.date);
    if (!parsed) return res.status(400).json({ error: 'That is not a calendar date.' });
    const day = wordSearchDays.get(parsed.date);
    const model = editorModel(parsed.date, stateFromBody(req.body, parsed.date), day);
    res.render('partials/daily-preview', { ...res.locals, ...model }, (err, html) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'The preview could not be drawn.' });
      }
      res.json({ html, canSave: model.composed.canSave, seed: model.state.seed });
    });
  });

  router.post('/daily/:date/delete', (req, res) => {
    const date = dateParam(req, res);
    if (!date) return;
    if (isPast(date)) {
      req.flash('warning', 'Past days are read-only.');
      return res.redirect(`/admin/daily/${date}`);
    }
    const removed = wordSearchDays.remove(date);
    req.flash('success', removed ? `Deleted the puzzle for ${date}; that day is automatic again.` : `${date} was not planned.`);
    res.redirect(`/admin/days/${date}#wordsearch`);
  });
}
