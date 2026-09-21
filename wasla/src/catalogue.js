/**
 * What the app hands out: badges, avatars and frames.
 *
 * The rules themselves live in the app — it decides when a badge is earned and
 * when an avatar opens — so nothing here is enforced. It is the panel's copy of
 * the catalogue, so "who earned what" and "what opens this avatar" can be read
 * without a Swift file open. `tests/catalogue.test.js` pins it to the avatar
 * list the API validates against, so the two cannot drift apart unnoticed.
 */
import { AVATARS, FRAMES } from './profiles.js';

/** The counters a badge can be about, in the order the app lists them. */
export const BADGE_KINDS = Object.freeze(['words', 'levels', 'streak', 'points']);

export const BADGE_KIND_TITLES = Object.freeze({
  words: 'الكلمات',
  levels: 'الألغاز',
  streak: 'السلاسل',
  points: 'النقاط',
});

/** Every badge id the app can send, `wasla.<kind>.<goal>`. */
export const BADGES = Object.freeze([
  ...[10, 50, 100, 250, 500, 1000, 2500, 5000].map((n) => `wasla.words.${n}`),
  ...[1, 5, 10, 25, 50, 100].map((n) => `wasla.levels.${n}`),
  ...[3, 7, 14, 30, 60, 100, 365].map((n) => `wasla.streak.${n}`),
  ...[500, 1000, 2500, 5000, 10000, 25000, 50000, 100000].map((n) => `wasla.points.${n}`),
]);

/** `{ kind, goal }` of a badge id, or null when it is not one of ours. */
export function readBadge(id) {
  const [prefix, kind, goal] = String(id ?? '').split('.');
  if (prefix !== 'wasla' || !BADGE_KINDS.includes(kind)) return null;
  const count = Number(goal);
  return Number.isInteger(count) && count > 0 ? { kind, goal: count } : null;
}

/** Arabic counted nouns: the plural for 3–10, the singular after that. */
const counted = (n, few, many) => (n >= 3 && n <= 10 ? few : many);

/** The badge's title, worded as the app words it on the profile. */
export function badgeTitle(id) {
  const badge = readBadge(id);
  if (!badge) return id;
  const { kind, goal } = badge;
  switch (kind) {
    case 'words': return goal === 1 ? 'حللت كلمة' : `حللت ${goal} ${counted(goal, 'كلمات', 'كلمة')}`;
    case 'levels': return goal === 1 ? 'أنهيت أول لغز' : `أنهيت ${goal} ${counted(goal, 'ألغاز', goal < 100 ? 'لغزاً' : 'لغز')}`;
    case 'streak': return `سلسلة ${goal} ${counted(goal, 'أيام', goal < 100 ? 'يوماً' : 'يوم')}`;
    default: return `جمعت ${goal} ${counted(goal, 'نقاط', 'نقطة')}`;
  }
}

/** What each counter is, so the panel can say how a badge is earned. */
export const BADGE_KIND_NOTES = Object.freeze({
  words: 'الكلمات المحلولة في كل الألعاب',
  levels: 'الألغاز المنتهية',
  streak: 'أطول سلسلة أيام بلغت',
  points: 'النقاط المجموعة (الإنفاق لا ينقصها)',
});

/**
 * The avatars that are not free, and what opens them. Everything else in
 * `AVATARS` is open from the start.
 */
export const AVATAR_LOCKS = Object.freeze({
  crown: { kind: 'badge', badge: 'wasla.streak.30' },
  'wizard-hat': { kind: 'badge', badge: 'wasla.levels.50' },
  globe: { kind: 'badge', badge: 'wasla.words.1000' },
  gem: { kind: 'badge', badge: 'wasla.points.10000' },
  firework: { kind: 'coins', coins: 200 },
  snowman: { kind: 'coins', coins: 200 },
  ufo: { kind: 'coins', coins: 200 },
  'piggy-bank': { kind: 'coins', coins: 300 },
  crystal: { kind: 'coins', coins: 300 },
  'magic-carpet': { kind: 'coins', coins: 300 },
  fanous: { kind: 'event', event: 'ramadan' },
  eidiya: { kind: 'event', event: 'eid' },
  'friday-star': { kind: 'event', event: 'friday' },
});

/** How an event reward is earned in the app, for the panel to show. */
export const EVENT_REWARD_NOTES = Object.freeze({
  ramadan: 'يُفتح بعد اللعب في 15 ليلة من رمضان',
  eid: 'يُفتح باللعب في يوم من أيام العيد',
  friday: 'يُفتح بعد اللعب في 4 جُمَع',
});

export const FRAME_TITLES = Object.freeze({ ramadan: 'إطار الهلال', eid: 'إطار العيد' });

/** The lock on an avatar, in Arabic; '' when it is free. */
export function lockNote(id) {
  const lock = AVATAR_LOCKS[id];
  if (!lock) return '';
  if (lock.kind === 'badge') return `شارة «${badgeTitle(lock.badge)}»`;
  if (lock.kind === 'coins') return `${lock.coins} عملة`;
  return EVENT_REWARD_NOTES[lock.event] ?? '';
}

/** Every avatar with its lock, in the order the app lists them. */
export const avatarCatalogue = () => AVATARS.map((id) => ({ id, lock: AVATAR_LOCKS[id] ?? null, note: lockNote(id) }));

/** Every frame with its title; frames come from an event's reward. */
export const frameCatalogue = () => FRAMES.map((id) => ({
  id,
  title: FRAME_TITLES[id] ?? id,
  note: EVENT_REWARD_NOTES[id] ?? '',
}));
