/**
 * app-ads.txt (IAB): which ad sellers may sell this app's adverts. AdMob reads it
 * from the developer website on the App Store listing, and limits the adverts of
 * an app it cannot find it for — one reason a banner that showed on the first
 * levels could stop showing at all.
 *
 * One line: Google, this publisher, a direct account, and Google's own
 * certification id (the same on every AdMob app-ads.txt).
 */
const GOOGLE_CERTIFICATION_ID = 'f08c47fec0942fa0';
const APP_ID = /^ca-app-pub-(\d{16})~\d{10}$/;

/** The file for this AdMob app id, or '' when there is no id to name. */
export function appAdsTxt(appId) {
  const match = APP_ID.exec(String(appId ?? '').trim());
  return match ? `google.com, pub-${match[1]}, DIRECT, ${GOOGLE_CERTIFICATION_ID}\n` : '';
}
