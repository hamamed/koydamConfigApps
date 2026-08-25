import { timingSafeEqual } from 'node:crypto';

import { Router } from 'express';

import { config } from '../config.js';
import { query } from '../db/pool.js';
import { log } from '../log.js';
import { forService } from '../settings.js';
import { serviceNames } from '../settings-catalogue.js';

/**
 * Single sign-on for the other panels on this box.
 *
 * The session cookie is set on `.hamaprojects.com`, so a browser already sends
 * it to api. and skincraft. What those services cannot do is *read* it — a
 * session id means nothing without the database behind it. This endpoint is
 * how they ask.
 *
 * ## Why introspection rather than a signed token
 *
 * A signed token would verify locally with no round trip, which is faster. But
 * it cannot be revoked: disabling an account would leave that person signed
 * into Brawl and SkinCraft until their token expired. Introspection keeps one
 * source of truth, and callers cache for a minute so the cost is negligible.
 */
export const ssoRouter = Router();

/**
 * Only our own services may ask.
 *
 * The session id would be enough to answer, but requiring a token as well
 * stops the endpoint being a public oracle for probing guessed ids, and means
 * a cookie stolen from a browser cannot be validated by anything that is not
 * already inside the estate.
 */
function serviceAuthorised(req) {
  const expected = config.serviceToken;
  if (!expected) return false;

  const provided = req.get('x-service-token') ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * POST /api/session/introspect  { sid }
 *
 * Answers "who is this, and what may they administer".
 */
ssoRouter.post('/api/session/introspect', async (req, res) => {
  if (!config.serviceToken) {
    // Fail closed and say why. Silently returning 401 here would look like a
    // wrong token and send someone hunting the wrong problem.
    return res.status(503).json({
      error: 'sso_disabled',
      message: 'SERVICE_TOKEN is not configured on platform-api.',
    });
  }

  if (!serviceAuthorised(req)) {
    log.warn('Rejected introspection', { ip: req.ip });
    return res.status(401).json({ error: 'bad_service_token' });
  }

  const sid = String(req.body?.sid ?? '');
  if (!sid) return res.json({ active: false });

  const result = await query(
    `SELECT u.id, u.email, u.name, u.role, u.disabled
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now()`,
    [sid],
  );

  const row = result?.rows?.[0];
  // A disabled account reads as inactive, not as a user with no permissions —
  // the caller should treat it as signed out, which is what disabling means.
  if (!row || row.disabled) return res.json({ active: false });

  const grants = await query(
    'SELECT app_slug, role FROM user_app_roles WHERE user_id = $1',
    [row.id],
  );

  res.json({
    active: true,
    user: {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      grants: Object.fromEntries(
        (grants?.rows ?? []).map((g) => [g.app_slug, g.role]),
      ),
    },
  });
});

/**
 * GET /api/services/:slug/settings
 *
 * What a service should apply, decrypted. Authenticated by the same service
 * token as introspection - this returns real API keys, so it is the most
 * sensitive endpoint on the box and shares the strictest gate it has.
 */
ssoRouter.get('/api/services/:slug/settings', async (req, res) => {
  if (!config.serviceToken) {
    return res.status(503).json({
      error: 'not_configured',
      message: 'SERVICE_TOKEN is not configured on platform-api.',
    });
  }

  if (!serviceAuthorised(req)) {
    log.warn('Rejected settings fetch', { ip: req.ip, service: req.params.slug });
    return res.status(401).json({ error: 'bad_service_token' });
  }

  const slug = String(req.params.slug ?? '').toLowerCase();
  if (!serviceNames().includes(slug)) {
    return res.status(404).json({ error: 'unknown_service' });
  }

  const settings = await forService(slug);

  // Never cached by anything in between. These are credentials.
  res.set('Cache-Control', 'no-store');
  res.json({ service: slug, settings, fetchedAt: new Date().toISOString() });
});

/**
 * Whether a post-login redirect may go to this URL.
 *
 * An open redirect on a login page is a phishing primitive: sign in at the
 * real site, get bounced to a copy that asks again. Only hosts we run.
 */
export function safeRedirect(next) {
  if (!next) return null;

  let url;
  try {
    url = new URL(next);
  } catch {
    // A relative path is same-origin by definition, so it is always safe —
    // but only if it really is a path and not a scheme-relative `//evil.com`.
    return next.startsWith('/') && !next.startsWith('//') ? next : null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const allowed = config.allowedRedirectHosts;
  if (!allowed.length) return null;

  return allowed.includes(url.host.toLowerCase()) ? url.toString() : null;
}
