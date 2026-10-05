import { timingSafeEqual } from 'node:crypto';

/**
 * Who may use the control routes under /internal.
 *
 * They are for the control panel on this same machine, which calls the
 * service directly on its local port. Two things must hold:
 *
 *  - the caller presents PANEL_TOKEN, compared in constant time;
 *  - the request did not come through nginx. The proxy always adds
 *    X-Forwarded-For, a direct local call never has it, so anything arriving
 *    from the internet is refused even if the token leaked.
 *
 * With no token configured the routes do not exist at all.
 */
export function internalAccess(headers, token) {
  const expected = String(token ?? '').trim();
  if (!expected) return 'disabled';
  if (headers['x-forwarded-for'] !== undefined || headers['x-real-ip'] !== undefined) return 'outside';

  const given = Buffer.from(String(headers.authorization ?? '').replace(/^Bearer /, ''));
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted) ? 'ok' : 'denied';
}
