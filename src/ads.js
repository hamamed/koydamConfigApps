/**
 * AdMob unit identifiers: validation, and Google's test units.
 *
 * Kept apart from the routes because both the write path and the read path
 * need them - one to refuse a malformed id, the other to substitute test ids
 * when an app is in test mode.
 */

/**
 * The shape AdMob issues: a publisher id, then a unit id.
 *
 *   ca-app-pub-1234567890123456/1234567890
 *
 * Worth checking because nothing downstream does. A mistyped id is accepted by
 * the SDK, requests it, and gets no fill - so the failure looks like poor
 * demand rather than a typo, and the revenue is simply gone until someone
 * compares the string by eye.
 */
const UNIT_PATTERN = /^ca-app-pub-\d{16}\/\d{10}$/;

/** The app id from AdMob → Settings. A tilde, not a slash. */
const APP_ID_PATTERN = /^ca-app-pub-\d{16}~\d{10}$/;

export const isValidUnitId = (id) => UNIT_PATTERN.test(String(id ?? '').trim());
export const isValidAppId = (id) => APP_ID_PATTERN.test(String(id ?? '').trim());

/**
 * Google's public test units, per platform.
 *
 * https://developers.google.com/admob/android/test-ads and the iOS equivalent.
 * These are Google's own and always fill, which is what makes them useful for
 * a review build: the layout is exercised without serving a real advert.
 */
const TEST_UNITS = {
  android: {
    appId: 'ca-app-pub-3940256099942544~3347511713',
    banner: 'ca-app-pub-3940256099942544/6300978111',
    interstitial: 'ca-app-pub-3940256099942544/1033173712',
    native: 'ca-app-pub-3940256099942544/2247696110',
    appOpen: 'ca-app-pub-3940256099942544/9257395921',
    rewarded: 'ca-app-pub-3940256099942544/5224354917',
  },
  ios: {
    appId: 'ca-app-pub-3940256099942544~1458002511',
    banner: 'ca-app-pub-3940256099942544/2934735716',
    interstitial: 'ca-app-pub-3940256099942544/4411468910',
    native: 'ca-app-pub-3940256099942544/3986624511',
    appOpen: 'ca-app-pub-3940256099942544/5575463023',
    rewarded: 'ca-app-pub-3940256099942544/1712485313',
  },
};

/**
 * Swaps configured units for Google's test ones.
 *
 * Only placements the app actually has are replaced. Returning the full test
 * set instead would switch on a placement that is off in the real config, and
 * the point of test mode is to exercise what ships - not something else.
 *
 * A placement with no Google equivalent keeps its real id rather than
 * disappearing: a missing unit reads to the client as "this placement is
 * disabled", which is a different test.
 */
export function applyTestUnits(units, platform) {
  const test = TEST_UNITS[platform];
  if (!test) return units;

  return Object.fromEntries(
    Object.entries(units ?? {}).map(([placement, id]) => [
      placement,
      test[placement] ?? id,
    ]),
  );
}

export const testAppId = (platform) => TEST_UNITS[platform]?.appId ?? null;

export const testPlacements = (platform) =>
  Object.keys(TEST_UNITS[platform] ?? {}).filter((k) => k !== 'appId');
