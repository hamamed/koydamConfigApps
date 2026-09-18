import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { createAppConfig } from '../src/app-config.js';
import { dayToDate, parseDay } from '../src/daily.js';
import { openDatabase } from '../src/db/index.js';
import { createRepository } from '../src/repository.js';
import {
  EVENT_KINDS, EVENT_THEMES, EVENT_WORD_ID_BASE, eventFor, eventLabel, eventQuestions, hijriOf,
} from '../src/seasonal-events.js';
import { boardForTheme, createWordSearch, eventTheme, MIN_THEME_WORDS, sizeForDay } from '../src/wordsearch-daily.js';
import { cellsOf, MAX_SIZE, MIN_SIZE } from '../src/wordsearch.js';

const plus = (date, n) => dayToDate(parseDay(date).day + n);

/** The first date from `from` that Intl's Umm al-Qura calendar calls Hijri `month`/`day`. */
function firstHijri(from, month, day) {
  for (let i = 0; i < 60; i++) {
    const date = plus(from, i);
    const hijri = hijriOf(date);
    if (hijri.month === month && hijri.day === day) return date;
  }
  throw new Error(`No ${month}/${day} within 60 days of ${from}`);
}

test('Intl gives the Umm al-Qura dates the app uses for the reference days', (t) => {
  for (const date of ['2027-02-07', '2027-02-08', '2027-03-09', '2027-03-10', '2026-05-26', '2026-05-27', '2026-09-18']) {
    t.diagnostic(`${date} → ${JSON.stringify(hijriOf(date))} → ${JSON.stringify(eventFor(date))}`);
  }
  assert.deepEqual(hijriOf('2027-02-08'), { year: 1448, month: 9, day: 1 });
  assert.deepEqual(hijriOf('2026-05-27'), { year: 1447, month: 12, day: 10 });
  assert.equal(hijriOf('2026-02-30'), null);
});

test('Ramadan is Hijri month 9, its night the Hijri day, and the day before is not Ramadan', () => {
  const first = firstHijri('2027-01-25', 9, 1);
  assert.equal(first, '2027-02-08');
  assert.deepEqual(eventFor(first), { kind: 'ramadan', night: 1 });
  assert.notEqual(eventFor(plus(first, -1))?.kind, 'ramadan');
  assert.deepEqual(eventFor(plus(first, 4)), { kind: 'ramadan', night: 5 }); // 2027-02-12, a Friday: Ramadan wins
  assert.equal(new Date('2027-02-12T12:00:00Z').getUTCDay(), 5);
  const last = plus(firstHijri('2027-02-20', 10, 1), -1);
  assert.equal(eventFor(last).kind, 'ramadan');
  assert.ok([29, 30].includes(eventFor(last).night));
});

test('Eid al-Fitr is Shawwal 1–3, and Eid al-Adha Dhu al-Hijjah 10–13, winning over Friday', () => {
  const fitr = firstHijri('2027-03-01', 10, 1);
  assert.equal(fitr, '2027-03-09');
  for (let i = 0; i < 3; i++) assert.deepEqual(eventFor(plus(fitr, i)), { kind: 'eid-fitr', night: null });
  assert.deepEqual(eventFor(plus(fitr, 3)), { kind: 'friday', night: null }); // Shawwal 4, 2027-03-12, a Friday

  const adha = firstHijri('2026-05-15', 12, 10);
  assert.equal(adha, '2026-05-27');
  assert.equal(eventFor(plus(adha, -1)), null); // the day of Arafah, a Tuesday
  for (let i = 0; i < 4; i++) assert.deepEqual(eventFor(plus(adha, i)), { kind: 'eid-adha', night: null }, plus(adha, i));
  assert.equal(new Date(`${plus(adha, 2)}T12:00:00Z`).getUTCDay(), 5, '2026-05-29 is a Friday inside the Eid');
  assert.equal(eventFor(plus(adha, 4)), null);
});

test('every Friday is an event; other days and bad dates are not', () => {
  assert.deepEqual(eventFor('2026-09-18'), { kind: 'friday', night: null });
  assert.deepEqual(eventFor('2026-09-25'), { kind: 'friday', night: null });
  assert.equal(eventFor('2026-09-17'), null);
  assert.equal(eventFor('2026-09-19'), null);
  for (const bad of ['2026-02-30', 'today', '', null, undefined]) assert.equal(eventFor(bad), null);
});

test('the panel labels: رمضان n, عيد الفطر, عيد الأضحى, الجمعة', () => {
  assert.equal(eventLabel({ kind: 'ramadan', night: 5 }), 'رمضان 5');
  assert.equal(eventLabel({ kind: 'eid-fitr', night: null }), 'عيد الفطر');
  assert.equal(eventLabel({ kind: 'eid-adha', night: null }), 'عيد الأضحى');
  assert.equal(eventLabel({ kind: 'friday', night: null }), 'الجمعة');
  assert.equal(eventLabel(null), '');
});

test('each event theme keeps at least 10 words after filtering, with ids no question can have', () => {
  const allIds = [];
  for (const kind of EVENT_KINDS) {
    const theme = eventTheme(kind);
    assert.equal(theme.title, EVENT_THEMES[kind].title);
    assert.ok(theme.words.length >= Math.max(MIN_THEME_WORDS, 10), `${kind}: ${theme.words.length} words`);
    assert.deepEqual(theme.skipped, [], kind);
    for (const w of theme.words) {
      assert.ok(Number.isInteger(w.id) && w.id > EVENT_WORD_ID_BASE, `${kind}: ${w.id}`);
      assert.ok([...w.word].length >= 3 && [...w.word].length <= 8, w.word);
    }
    allIds.push(...eventQuestions(kind).map((q) => q.id));
    // Every size a board can be.
    for (let size = MIN_SIZE; size <= MAX_SIZE; size++) assert.ok(boardForTheme(theme, size, 12345 + size), `${kind} at ${size}`);
  }
  assert.equal(new Set(allIds).size, allIds.length);
  assert.equal(eventTheme('nope'), null);
  assert.deepEqual(eventQuestions('nope'), []);
  assert.equal(eventTheme('ramadan'), eventTheme('ramadan'), 'built once');
});

// ── The daily word search on event dates ───────────────────────────────────

let wordSearch;

beforeEach(() => {
  const db = openDatabase(':memory:');
  const repo = createRepository(db);
  for (const answer of ['أسد', 'نمر', 'فيل', 'زرافة', 'حصان', 'غزال', 'قرد', 'جمل']) {
    repo.createQuestion({ title: 'حيوانات', answer, clue: 'x' });
  }
  wordSearch = createWordSearch(db, { appConfig: createAppConfig(db) });
});

function assertEventBoard(board, date, title) {
  assert.equal(board.date, date);
  assert.equal(board.theme, title);
  assert.equal(board.size, sizeForDay(parseDay(date).day));
  const grid = board.rows.map((r) => [...r]);
  assert.ok(board.words.length >= MIN_THEME_WORDS && board.words.length <= 10);
  for (const w of board.words) {
    assert.ok(w.id > EVENT_WORD_ID_BASE);
    assert.equal(cellsOf(w).map(([r, c]) => grid[r][c]).join(''), w.word);
  }
}

test('an event date gets its theme, deterministically, and other dates the rotation', () => {
  const friday = wordSearch.forDate('2026-09-18');
  assertEventBoard(friday, '2026-09-18', 'جمعة مباركة');
  assert.deepEqual(wordSearch.forDate('2026-09-18'), friday);
  assert.notDeepEqual(wordSearch.forDate('2026-09-25').rows, friday.rows, 'each Friday is its own board');
  assertEventBoard(wordSearch.forDate('2027-02-10'), '2027-02-10', 'رمضان كريم');
  assertEventBoard(wordSearch.forDate('2027-03-10'), '2027-03-10', 'عيد الفطر');
  assertEventBoard(wordSearch.forDate('2026-05-28'), '2026-05-28', 'عيد الأضحى');
  assert.equal(wordSearch.forDate('2026-09-19').theme, 'حيوانات');

  const pick = wordSearch.eventPickForDate('2026-09-18');
  assert.deepEqual(pick.event, { kind: 'friday', night: null });
  assert.deepEqual(wordSearch.automaticPick('2026-09-18'), pick);
  assert.equal(wordSearch.eventPickForDate('2026-09-19'), null);
  assert.equal(wordSearch.eventPickForDate('2026-02-30'), null);
  // The rotation's own pick is unchanged on an event date.
  assert.equal(wordSearch.pickForDate('2026-09-18').theme, 'حيوانات');
});

test('an event date has a board even with no theme at all', () => {
  const empty = openDatabase(':memory:');
  const bare = createWordSearch(empty, { appConfig: createAppConfig(empty) });
  assertEventBoard(bare.forDate('2026-09-18'), '2026-09-18', 'جمعة مباركة');
  assert.equal(bare.forDate('2026-09-19'), null);
});
