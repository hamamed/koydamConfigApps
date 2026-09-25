/**
 * The public site (landing page, privacy, support, credits) lives on its own
 * domain; the API, media, panel and challenge links stay on the service's.
 *
 * The app, its universal links and the panel's sign-on cookie are all tied to
 * the service domain, so only the pages move. Each domain sends what it does
 * not serve to the other with a 301, so old links keep working. Off unless
 * `siteUrl` is set; hosts that are neither domain (a local run) are left alone.
 */
const SITE_PAGES = new Set(['/', '/privacy', '/support', '/credits']);
const SITE_FILES = [/^\/assets\//, /^\/favicon\.ico$/, /^\/robots\.txt$/];

const hostOf = (url) => (url ? new URL(url).hostname.toLowerCase() : '');

export function siteHost({ siteUrl, publicUrl }) {
  const site = hostOf(siteUrl);
  const service = hostOf(publicUrl);
  if (!site) return (_req, _res, next) => next();
  const siteBase = siteUrl.replace(/\/+$/, '');
  const serviceBase = publicUrl.replace(/\/+$/, '');

  return (req, res, next) => {
    // Only reads move: a redirected POST arrives as a GET and loses its body.
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const host = String(req.hostname ?? '').toLowerCase();
    const isSitePage = SITE_PAGES.has(req.path);

    if (host === `www.${site}`) return res.redirect(301, `${siteBase}${req.url}`);
    if (host === site) {
      if (isSitePage || SITE_FILES.some((p) => p.test(req.path))) return next();
      return res.redirect(301, `${serviceBase}${req.url}`);
    }
    if (host === service && isSitePage) return res.redirect(301, `${siteBase}${req.url}`);
    return next();
  };
}
