/**
 * Seasonal Islamic events: Ramadan, Eid al-Fitr, Eid al-Adha and every Friday.
 *
 * A date's event comes from the Umm al-Qura calendar — the one the app uses
 * (`Calendar(identifier: .islamicUmmAlQura)`), so server and app agree on
 * which day is which without asking each other. Pure: no I/O, no clock.
 *
 * Each kind has a built-in word-search theme (an Arabic title and its words).
 * The words here are raw; src/wordsearch-daily.js folds and filters them like
 * a title's answers (`eventTheme`).
 */

import { parseDay } from './daily.js';

export const EVENT_KINDS = Object.freeze(['ramadan', 'eid-fitr', 'eid-adha', 'friday']);

/** Hijri months (Umm al-Qura, 1-based) and the days in them that make an event. */
const RAMADAN = 9;
const SHAWWAL = 10;
const DHU_AL_HIJJAH = 12;
const EID_FITR_DAYS = [1, 3];
const EID_ADHA_DAYS = [10, 13];
/** `Date#getUTCDay()` of a Friday. */
const FRIDAY = 5;

/**
 * Words of an event theme take ids from here up (contract §5), far above the
 * custom (1000000001…) and typed game (2000000001…) ids, so they never count
 * as a question. Each kind has its own hundred: 3000000001… for Ramadan,
 * 3000000101… for Eid al-Fitr, and so on — the same word keeps its id.
 */
export const EVENT_WORD_ID_BASE = 3_000_000_000;
const IDS_PER_KIND = 100;

/** The built-in theme of each kind: title shown above the board, and its words. */
export const EVENT_THEMES = Object.freeze({
  ramadan: Object.freeze({
    title: 'رمضان كريم',
    answers: Object.freeze([
      'رمضان', 'صيام', 'سحور', 'إفطار', 'فانوس', 'هلال', 'تراويح', 'قرآن', 'زكاة', 'صدقة', 'تمر', 'قطايف',
      'كنافة', 'مسجد', 'دعاء', 'اعتكاف', 'مسحراتي', 'تلاوة', 'قيام', 'بركة', 'رحمة', 'مغفرة',
    ]),
  }),
  'eid-fitr': Object.freeze({
    title: 'عيد الفطر',
    answers: Object.freeze([
      'عيدية', 'تهنئة', 'حلوى', 'كعك', 'فرحة', 'زيارة', 'ملابس', 'هدية', 'معايدة', 'تكبير', 'صلاة', 'أطفال',
      'بالونات', 'ضيافة', 'معمول', 'أرجوحة', 'بهجة', 'أقارب', 'تسامح', 'سرور', 'ألعاب', 'شوكولاتة',
    ]),
  }),
  'eid-adha': Object.freeze({
    title: 'عيد الأضحى',
    answers: Object.freeze([
      'أضحية', 'تكبير', 'حجاج', 'عرفة', 'كعبة', 'طواف', 'إحرام', 'تلبية', 'زمزم', 'فرحة', 'زيارة', 'صلاة',
      'ضيافة', 'لحم', 'خروف', 'منى', 'مزدلفة', 'قربان', 'مكة', 'سعي', 'نحر', 'جمرات',
    ]),
  }),
  friday: Object.freeze({
    title: 'جمعة مباركة',
    answers: Object.freeze([
      'جمعة', 'خطبة', 'مسجد', 'صلاة', 'منبر', 'إمام', 'دعاء', 'ذكر', 'صدقة', 'سواك', 'طيب', 'تسبيح',
      'أذان', 'وضوء', 'سجود', 'ركوع', 'خشوع', 'جماعة', 'استغفار', 'كهف', 'غسل', 'سكينة',
    ]),
  }),
});

/**
 * A kind's words as question-like `{ id, answer }`, for themeWords. Ids are
 * EVENT_WORD_ID_BASE + the kind's hundred + the word's place (from 1).
 */
export function eventQuestions(kind) {
  const theme = EVENT_THEMES[kind];
  if (!theme) return [];
  const base = EVENT_WORD_ID_BASE + EVENT_KINDS.indexOf(kind) * IDS_PER_KIND;
  return theme.answers.map((answer, i) => ({ id: base + i + 1, answer }));
}

const hijriFormat = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', {
  timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric',
});

/**
 * Without full ICU data Intl quietly falls back to the Gregorian calendar,
 * whose month 9 is September: then only Fridays are events, never a false Ramadan.
 */
const hasUmmAlQura = hijriFormat.resolvedOptions().calendar === 'islamic-umalqura';
if (!hasUmmAlQura) console.error('Intl has no Umm al-Qura calendar: seasonal events are Fridays only.');

/** The part's number, whatever digits it is written in; NaN when there is none. */
function partNumber(parts, type) {
  const value = parts.find((p) => p.type === type)?.value ?? '';
  const latin = value.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/\D/g, '');
  return latin ? Number(latin) : NaN;
}

/** `{ year, month, day }` in the Umm al-Qura calendar for a date at noon UTC, or null. */
export function hijriOf(date) {
  if (!hasUmmAlQura || !parseDay(date)) return null;
  const parts = hijriFormat.formatToParts(new Date(`${date}T12:00:00Z`));
  const hijri = { year: partNumber(parts, 'year'), month: partNumber(parts, 'month'), day: partNumber(parts, 'day') };
  return Object.values(hijri).every(Number.isInteger) ? hijri : null;
}

const within = (day, [first, last]) => day >= first && day <= last;

/**
 * The event on a 'YYYY-MM-DD' date — `{ kind, night }` — or null. `night` is
 * the night of Ramadan (the Hijri day, 1–30); null for the other kinds.
 * Ramadan and the two Eids win over Friday.
 */
export function eventFor(date) {
  if (!parseDay(date)) return null;
  const hijri = hijriOf(date);
  if (hijri?.month === RAMADAN) return { kind: 'ramadan', night: hijri.day };
  if (hijri?.month === SHAWWAL && within(hijri.day, EID_FITR_DAYS)) return { kind: 'eid-fitr', night: null };
  if (hijri?.month === DHU_AL_HIJJAH && within(hijri.day, EID_ADHA_DAYS)) return { kind: 'eid-adha', night: null };
  if (new Date(`${date}T12:00:00Z`).getUTCDay() === FRIDAY) return { kind: 'friday', night: null };
  return null;
}

/** A short Arabic label for the panel: "رمضان 5", "عيد الفطر", "عيد الأضحى", "الجمعة"; '' for none. */
export function eventLabel(event) {
  if (!event) return '';
  if (event.kind === 'ramadan') return `رمضان ${event.night}`;
  return { 'eid-fitr': 'عيد الفطر', 'eid-adha': 'عيد الأضحى', friday: 'الجمعة' }[event.kind] ?? '';
}
