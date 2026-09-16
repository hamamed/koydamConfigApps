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
      const local = mirrorPlatformUser(platform);
      req.user = {
        // The LOCAL row's id, not the platform's. Everything that records who
        // did something is a foreign key into this database's users table.
        id: local.id,
        platformId: platform.id,
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


/**
 * The local row standing in for a platform account, created on first sight.
 *
 * Needed because items.created_by, audit_log.user_id and reports.resolved_by
 * are foreign keys into this database. Under SSO the person exists in
 * platform-api, not here, and their id there is meaningless here — passing it
 * straight through produced "FOREIGN KEY constraint failed" on every create,
 * upload and design. It worked for exactly one account: whoever happened to
 * share an id with the bootstrap admin.
 *
 * The mirror also makes the audit log readable. A row saying user 7 is no use
 * once user 7 is someone nobody remembers.
 */
function mirrorPlatformUser(platform) {
  const existing = db
    .prepare('SELECT id, username, role FROM users WHERE platform_id = ?')
    .get(platform.id);

  if (existing) {
    // Keep the name and role current — someone renamed at the platform should
    // not show up here under the address they signed up with two years ago.
    if (existing.username !== platform.email || existing.role !== platform.role) {
      try {
        db.prepare('UPDATE users SET username = ?, role = ? WHERE id = ?')
          .run(platform.email, platform.role, existing.id);
      } catch {
        // Their new address collides with another local row. The stale name is
        // cosmetic; refusing to load the user over it would not be.
      }
    }
    return existing;
  }

  // Never a usable password. `verifyCredentials` also refuses these rows
  // outright, so this is the second of two locks rather than the only one.
  const insert = (username) =>
    db.prepare(
      `INSERT INTO users (username, password_hash, role, platform_id)
       VALUES (?, '!sso', ?, ?)`,
    ).run(username, platform.role, platform.id);

  try {
    insert(platform.email);
  } catch {
    // A local account already holds that username — most often the bootstrap
    // admin. Suffixing keeps both, rather than one silently becoming the other.
    insert(`${platform.email}#${platform.id}`);
  }

  return db
    .prepare('SELECT id, username, role FROM users WHERE platform_id = ?')
    .get(platform.id);
}

export function verifyCredentials(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());

  // Hash even when the user doesn't exist, so response time doesn't reveal which usernames
  // are real.
  const hash = user?.password_hash || '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
  const ok = bcrypt.compareSync(String(password || ''), hash);

  if (!user || !ok) return null;

  // An SSO mirror row is a foreign-key target, not an account. Its stored hash
  // is not a hash and cannot match, but the check is explicit rather than
  // relying on that: whoever changes the sentinel one day should not be able to
  // turn every SSO user into a local login by accident.
  if (user.platform_id != null) return null;

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
