/**
 * Challenge links: https://…/c/<level>?t=<seconds>&s=<stars>, shared from the
 * app after finishing a level. The server only reads them to draw a landing
 * page and its link preview; the app opens the same path as a universal link.
 */

export const TEAM_APP_ID = '652935W544.koydam.wasla.crosswords';

/** Served as-is at both apple-app-site-association paths. */
export const APPLE_APP_SITE_ASSOCIATION = Object.freeze({
  applinks: { details: [{ appIDs: [TEAM_APP_ID], components: [{ '/': '/c/*' }] }] },
});

export const MAX_SECONDS = 86_399;
export const MAX_STARS = 3;

/** A positive whole level number written plainly ("3", not "03" or "3.0"), else null. */
export function parseLevelNumber(raw) {
  return typeof raw === 'string' && /^[1-9]\d{0,6}$/.test(raw) ? Number(raw) : null;
}

/**
 * `{ seconds, stars }` from the query, each null unless written exactly:
 * t a whole number 1–86399, s a single digit 0–3. Anything else is ignored
 * rather than refused: a mangled share still opens the level.
 */
export function parseChallenge(query = {}) {
  const t = typeof query.t === 'string' && /^[1-9]\d{0,4}$/.test(query.t) ? Number(query.t) : null;
  const s = typeof query.s === 'string' && /^[0-3]$/.test(query.s) ? Number(query.s) : null;
  return { seconds: t !== null && t <= MAX_SECONDS ? t : null, stars: s };
}

/** "1:20", or "1:02:05" past an hour. */
export function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** "?t=80&s=3" with only the values that were valid, or "". */
export function challengeQuery({ seconds, stars }) {
  const params = new URLSearchParams();
  if (seconds !== null) params.set('t', String(seconds));
  if (stars !== null) params.set('s', String(stars));
  const text = params.toString();
  return text ? `?${text}` : '';
}

const STAR_WORDS = ['بلا نجوم', 'بنجمة واحدة', 'بنجمتين', 'بثلاث نجوم'];

/** Everything the landing page and its preview need. */
export function challengePage({ level, seconds, stars, publicUrl }) {
  const query = challengeQuery({ seconds, stars });
  const time = seconds !== null ? formatDuration(seconds) : null;
  const title = time
    ? `تحداك صديق: حل لغز رقم ${level} في ${time} — هل تستطيع أسرع؟`
    : `تحداك صديق: حل لغز رقم ${level} — هل تستطيع؟`;
  const starText = stars !== null ? ` ${STAR_WORDS[stars]}` : '';
  const description = time
    ? `صديقك أنهى لغز رقم ${level} في وصلة خلال ${time}${starText}. افتح اللغز وحاول أن تسبقه.`
    : `صديقك أنهى لغز رقم ${level} في وصلة${starText}. افتح اللغز وحاول أن تتغلب عليه.`;
  return {
    level,
    seconds,
    stars,
    time,
    title,
    description,
    url: `${publicUrl}/c/${level}${query}`,
    appUrl: `wasla://c/${level}${query}`,
    image: `${publicUrl}/assets/logo/logo.png`,
  };
}
