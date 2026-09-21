/**
 * One game a day, the same game every weekday (contract §9).
 *
 * Six games shared one day between them, so each was small enough to finish in
 * a minute and nobody met all six. Now the week hands out one at a time — the
 * big version of it — and Friday runs all six back to back as a marathon.
 *
 * The other games of the date are still built and still sent: they stay open in
 * the archive to play for nothing. Only the day's own game pays.
 */

import { parseDay } from './daily.js';

/** The seven days, Sunday first — the order `weekdayOf` counts in. */
export const WEEK = Object.freeze([
  'wheel', // الأحد
  'guess', // الاثنين
  'wordsearch', // الثلاثاء
  'wheel', // الأربعاء
  'guess', // الخميس
  'marathon', // الجمعة
  'wordsearch', // السبت
]);

/** Every kind a day can hold, including the two that are not in GAME_KINDS. */
export const SCHEDULED_KINDS = Object.freeze([...new Set(WEEK)]);

export const WEEKDAY_NAMES = Object.freeze(['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت']);

export const KIND_NAMES = Object.freeze({
  wheel: 'عجلة الحروف',
  guess: 'خمّن الكلمتين',
  wordsearch: 'البحث عن الكلمات',
  marathon: 'ماراثون الجمعة',
});

/** 0 = Sunday … 6 = Saturday. Day 0 (1970-01-01) was a Thursday. */
export const weekdayOf = (day) => (((day + 4) % 7) + 7) % 7;

/** Which game that day number carries. */
export const kindForDay = (day) => WEEK[weekdayOf(day)];

/** Which game a `YYYY-MM-DD` date carries, or null when the date is not one. */
export function kindForDate(date) {
  const parsed = parseDay(date);
  return parsed ? kindForDay(parsed.day) : null;
}

/** The whole week as the app and the panel show it: `[{ weekday, name, kind, title }]`, Sunday first. */
export const schedule = () => WEEK.map((kind, weekday) => ({
  weekday,
  name: WEEKDAY_NAMES[weekday],
  kind,
  title: KIND_NAMES[kind],
}));
