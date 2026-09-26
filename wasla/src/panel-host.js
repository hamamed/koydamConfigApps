import { config } from './config.js';

/**
 * Which sign-in the panel uses for a request: `platform` (the single sign-on
 * of config.hamaprojects.com) or `local` (this service's own accounts).
 *
 * The platform's session cookie is set on `.hamaprojects.com`, so a browser
 * never sends it to the site's own domain (SITE_URL, chabbek.com): there the
 * platform cannot see who is signed in, and the panel falls back to its own
 * username-and-password login. The service domain keeps the sign-on.
 */
export function panelSignIn(req, { siteUrl = config.siteUrl, platformUrl = process.env.PLATFORM_URL ?? '' } = {}) {
  if (!platformUrl) return 'local';
  const site = siteUrl ? new URL(siteUrl).hostname.toLowerCase() : '';
  const host = String(req?.hostname ?? '').toLowerCase();
  return site && (host === site || host === `www.${site}`) ? 'local' : 'platform';
}

export const usesPlatformSignIn = (req) => panelSignIn(req) === 'platform';
