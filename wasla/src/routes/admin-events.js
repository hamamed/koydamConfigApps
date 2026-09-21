import { dayToDate, parseDay, todayUtc } from '../daily.js';
import { eventFor, EVENT_THEMES } from '../seasonal-events.js';

/** How far ahead the calendar looks: far enough to always hold the next Ramadan. */
const AHEAD_DAYS = 400;

export const EVENT_TITLES = Object.freeze({
  ramadan: 'رمضان',
  'eid-fitr': 'عيد الفطر',
  'eid-adha': 'عيد الأضحى',
  friday: 'الجمعة',
});

/** What each event changes in the app, in the panel's words. */
export const EVENT_NOTES = Object.freeze({
  ramadan: 'موضوع «رمضان كريم» في البحث عن الكلمات، ومكافأة إنهاء ألعاب اليوم ×2، وصورة «فانوس» بعد اللعب في 15 ليلة.',
  'eid-fitr': 'موضوع «عيد الفطر»، ومكافأة إنهاء ألعاب اليوم ×3، وصورة «عيدية» وإطار العيد.',
  'eid-adha': 'موضوع «عيد الأضحى»، ومكافأة إنهاء ألعاب اليوم ×3، وصورة «عيدية» وإطار العيد.',
  friday: 'موضوع «جمعة مباركة»، ومكافأة إنهاء ألعاب اليوم ×2، وصورة «نجمة الجمعة» بعد أربع جُمَع.',
});

/**
 * The seasonal calendar: when the app's events fall, and what each one changes.
 *
 * The dates come from the Umm al-Qura calendar through `eventFor`, the same
 * function the word search and the day planner ask — so what is listed here is
 * exactly what players will get.
 */
export function registerEvents(router) {
  router.get('/events', (_req, res) => {
    const today = todayUtc();
    const start = parseDay(today).day;

    // Consecutive days of one kind are one spell: Ramadan is a month, an Eid a
    // few days, a Friday a single day.
    const spells = [];
    let fridays = 0;
    for (let i = 0; i < AHEAD_DAYS; i++) {
      const date = dayToDate(start + i);
      const event = eventFor(date);
      if (!event) continue;
      if (event.kind === 'friday') {
        fridays++;
        if (fridays <= 8) spells.push({ kind: 'friday', from: date, to: date, days: 1, single: true });
        continue;
      }
      const last = spells[spells.length - 1];
      if (last && last.kind === event.kind && parseDay(last.to).day === start + i - 1) {
        last.to = date;
        last.days++;
      } else {
        spells.push({ kind: event.kind, from: date, to: date, days: 1, single: false });
      }
    }

    const seasons = spells.filter((s) => s.kind !== 'friday');
    res.render('events', {
      title: 'المناسبات',
      today,
      aheadDays: AHEAD_DAYS,
      seasons: seasons.map((s) => ({
        ...s,
        title: EVENT_TITLES[s.kind],
        note: EVENT_NOTES[s.kind],
        words: EVENT_THEMES[s.kind]?.answers.length ?? 0,
        themeTitle: EVENT_THEMES[s.kind]?.title ?? '',
        starts: Math.max(0, parseDay(s.from).day - start),
      })),
      fridays: spells.filter((s) => s.kind === 'friday'),
      fridayNote: EVENT_NOTES.friday,
      fridayTheme: EVENT_THEMES.friday.title,
      fridayWords: EVENT_THEMES.friday.answers.length,
      hijriMissing: eventFor(today) === null && seasons.length === 0,
    });
  });
}
