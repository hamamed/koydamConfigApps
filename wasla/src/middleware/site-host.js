/**
 * The site's own domain (SITE_URL, chabbek.com) serves everything: the landing
 * page, privacy, support and credits, the panel, the app's API, its pictures,
 * challenge links and the file iOS reads for universal links.
 *
 * The old domain (LEGACY_HOSTS, wassla.hamaprojects.com) keeps serving all of
 * that too — the app versions already on phones talk to it, and links already
 * shared point at it — except its public pages, which it sends to the site with
 * a 301 so there is one of each for search engines and readers. `www.` goes to
 * the bare domain. Hosts that are neither (a local run) are left alone, and so
 * is everything when no site is set.
 */
const SITE_PAGES = new Set(['/', '/privacy', '/support', '/credits', '/sitemap.xml']);

const hostOf = (url) => (url ? new URL(url).hostname.toLowerCase() : '');

export function siteHost({ siteUrl, legacyHosts = [] }) {
  const site = hostOf(siteUrl);
  if (!site) return (_req, _res, next) => next();
  const siteBase = siteUrl.replace(/\/+$/, '');
  const legacy = new Set(legacyHosts.map((h) => String(h).trim().toLowerCase()).filter((h) => h && h !== site));

  return (req, res, next) => {
    // Only reads move: a redirected POST arrives as a GET and loses its body.
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const host = String(req.hostname ?? '').toLowerCase();
    if (host === `www.${site}`) return res.redirect(301, `${siteBase}${req.url}`);
    if (legacy.has(host) && SITE_PAGES.has(req.path)) return res.redirect(301, `${siteBase}${req.url}`);
    return next();
  };
}
