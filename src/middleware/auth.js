import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { platformUser, requirePlatformAuth } from './platform-auth.js';

/**
 * Loads the signed-in user onto `req.user` and `res.locals.user`.
 *
 * Prefers the platform session from config.hamaprojects.com, so this panel has
 * no login of its own. Falls back to the local session when PLATFORM_URL is
 * unset — which keeps a standalone install, or a local dev copy, working.
 */
export async function loadUser(req, res, next) {
  if (process.env.PLATFORM_URL) {
    const platform = await platformUser(req);
    if (platform) {
      req.user = {
        id: platform.id,
        username: platform.email,
        role: platform.role,
        platform: true,
      };
      res.locals.user = req.user;
      return next();
    }
  }

  const userId = req.session?.userId;
  if (userId) {
    req.user = db
      .prepare('SELECT id, username, role, created_at, last_login_at FROM users WHERE id = ?')
      .get(userId);
    // The session outlived the account (deleted user) — treat it as signed out.
    if (!req.user) req.session.destroy(() => {});
  }
  res.locals.user = req.user || null;
  next();
}

/**
 * Gate for admin pages.
 *
 * With SSO on, an unauthenticated request bounces to the platform login and
 * returns here afterwards — this panel has no password of its own. Without
 * PLATFORM_URL the original local login still applies.
 */
const platformGate = requirePlatformAuth();

export function requireAuth(req, res, next) {
  if (req.user) return next();

  if (process.env.PLATFORM_URL) return platformGate(req, res, next);

  const returnTo = req.originalUrl.startsWith('/admin') ? req.originalUrl : '/admin';
  return res.redirect(`/admin/login?next=${encodeURIComponent(returnTo)}`);
}

export function verifyCredentials(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());

  // Hash even when the user doesn't exist, so response time doesn't reveal which usernames
  // are real.
  const hash = user?.password_hash || '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
  const ok = bcrypt.compareSync(String(password || ''), hash);

  if (!user || !ok) return null;

  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  return { id: user.id, username: user.username, role: user.role };
}

/**
 * Issues the per-session CSRF secret and exposes it to templates.
 *
 * Split from the check below because of body parsing: a multipart form's fields don't exist on
 * `req.body` until multer has consumed the stream, so the token can only be *verified* after
 * the upload middleware has run — but it must be *available* to every rendered form long before
 * that.
 */
export function csrfToken(req, res, next) {
  if (!req.session.csrfSecret) {
    req.session.csrfSecret = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfSecret;
  next();
}

/**
 * Double-submit CSRF check, comparing the submitted token against the session secret in
 * constant time. (`csurf` is deprecated and unmaintained; this is the same mechanism in a form
 * small enough to audit at a glance.)
 *
 * **Ordering matters.** On routes that accept file uploads this must be chained *after* the
 * multer middleware. If it runs first the body is still an unparsed stream, and rather than
 * silently skipping the check it fails closed with an explanatory error.
 */
export function csrfProtect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  if (req.is('multipart/*') && !req.body) {
    return next(
      Object.assign(
        new Error('CSRF check ran before the upload middleware — chain csrfProtect after multer.'),
        { status: 500 }
      )
    );
  }

  const submitted = String(req.body?._csrf || req.get('x-csrf-token') || '');
  const expected = req.session.csrfSecret || '';
  const valid =
    submitted.length > 0 &&
    submitted.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(expected));

  if (!valid) {
    return next(
      Object.assign(new Error('Your session expired. Please try that again.'), { status: 403 })
    );
  }
  return next();
}

/** One-shot flash messages, stored on the session and cleared on read. */
export function flash(req, res, next) {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;

  req.flash = (type, message) => {
    req.session.flash = { type, message };
  };
  next();
}
