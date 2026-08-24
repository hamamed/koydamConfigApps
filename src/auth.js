import { randomBytes, timingSafeEqual } from 'node:crypto';

import bcrypt from 'bcryptjs';

import { config } from './config.js';
import { query } from './db/pool.js';
import { log } from './log.js';

/**
 * Accounts, sessions and authorisation.
 *
 * ## Why server-side sessions
 *
 * A signed stateless cookie is simpler and needs no table, but it cannot be
 * revoked: once issued it is valid until it expires, whatever happens to the
 * account. An admin who leaves, or a laptop left on a train, has to be cut off
 * *now* — so sessions live in Postgres and a delete is immediate.
 *
 * ## Why no key in a URL
 *
 * The previous model put ADMIN_KEY in the query string. That lands in browser
 * history, bookmarks, nginx access logs and every screenshot of the panel, and
 * it is all-or-nothing — there is no way to hand someone one app.
 */

export const COOKIE = 'platform_sid';

/** Long enough not to nag, short enough that a stolen laptop expires. */
const SESSION_HOURS = 12;

/** bcrypt rounds. 12 is ~250ms on this class of VPS: slow for an attacker,
 *  unnoticeable on a login that happens a few times a day. */
const BCRYPT_ROUNDS = 12;

const MAX_FAILED = 8;
const LOCKOUT_MINUTES = 15;

// ── Passwords ───────────────────────────────────────────────────────────────

export const hashPassword = (plain) => bcrypt.hash(plain, BCRYPT_ROUNDS);

/**
 * Always runs a real comparison, even for an unknown account.
 *
 * Returning early on "no such user" makes the response measurably faster for
 * a wrong email than a wrong password, which turns the login form into an
 * account-enumeration oracle.
 */
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.eS8H1Kn0DRp8oq6Y3nBnvKuKfPzP2Uy';

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash ?? DUMMY_HASH);
}

// ── Cookies ─────────────────────────────────────────────────────────────────

function setSessionCookie(res, sid) {
  const parts = [
    `${COOKIE}=${sid}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_HOURS * 3600}`,
  ];
  // Secure would make the cookie unusable over plain HTTP, which is how this
  // is reached before certbot has run.
  if (config.env === 'production' && config.secureCookies) parts.push('Secure');

  // The whole point of one sign-in: a cookie scoped to config.hamaprojects.com
  // is invisible to api. and skincraft., so those would still need their own
  // logins. A leading dot shares it across every subdomain.
  if (config.cookieDomain) parts.push(`Domain=${config.cookieDomain}`);
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  // The domain must match the one it was set with, or the browser keeps the
  // original cookie and signing out appears to do nothing.
  const domain = config.cookieDomain ? `; Domain=${config.cookieDomain}` : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax${domain}; Max-Age=0`,
  );
}

/** Minimal parser — avoids a cookie-parser dependency for one cookie. */
export function readCookie(req, name) {
  const header = req.headers.cookie ?? '';
  for (const pair of header.split(';')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    if (pair.slice(0, i).trim() === name) {
      return decodeURIComponent(pair.slice(i + 1).trim());
    }
  }
  return null;
}

// ── Sessions ────────────────────────────────────────────────────────────────

export async function createSession(user, req, res) {
  const sid = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');

  await query(
    `INSERT INTO sessions (id, user_id, expires_at, ip, user_agent, csrf)
     VALUES ($1, $2, now() + ($3 || ' hours')::interval, $4, $5, $6)`,
    [
      sid,
      user.id,
      String(SESSION_HOURS),
      req.ip ?? null,
      (req.get('user-agent') ?? '').slice(0, 255),
      csrf,
    ],
  );

  setSessionCookie(res, sid);
  return { sid, csrf };
}

export async function destroySession(req, res) {
  const sid = readCookie(req, COOKIE);
  if (sid) await query('DELETE FROM sessions WHERE id = $1', [sid]);
  clearSessionCookie(res);
}

/** Removes expired rows. Called on a timer, not per request. */
export async function sweepSessions() {
  const res = await query('DELETE FROM sessions WHERE expires_at < now()');
  const n = res?.rowCount ?? 0;
  if (n) log.debug('Swept expired sessions', { removed: n });
  return n;
}

/**
 * Resolves the current user, or null.
 *
 * Also refreshes `last_seen_at`, which is what makes the active-session list
 * useful — "signed in 3 days ago" and "active two minutes ago" are different
 * facts when deciding what to revoke.
 */
export async function currentUser(req) {
  const sid = readCookie(req, COOKIE);
  if (!sid) return null;

  const res = await query(
    `SELECT u.id, u.email, u.name, u.role, u.disabled, s.csrf, s.id AS sid
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now()`,
    [sid],
  );

  const row = res?.rows?.[0];
  if (!row || row.disabled) return null;

  // Fire and forget: a timestamp must not add a round trip to every request.
  query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [sid]).catch(
    () => {},
  );

  const grants = await query(
    'SELECT app_slug, role FROM user_app_roles WHERE user_id = $1',
    [row.id],
  );

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    csrf: row.csrf,
    sid: row.sid,
    grants: Object.fromEntries(
      (grants?.rows ?? []).map((g) => [g.app_slug, g.role]),
    ),
  };
}

// ── Sign in ─────────────────────────────────────────────────────────────────

/**
 * Verifies credentials and applies lockout.
 *
 * Returns `{ user }` or `{ error }`. The error strings are deliberately
 * identical for a wrong email and a wrong password — the only case that says
 * more is a lockout, which reveals nothing an attacker could not measure.
 */
export async function signIn(email, password) {
  const res = await query(
    `SELECT id, email, name, role, password_hash, disabled,
            failed_attempts, locked_until
       FROM users WHERE lower(email) = lower($1)`,
    [String(email ?? '').trim()],
  );

  const row = res?.rows?.[0];

  if (row?.locked_until && new Date(row.locked_until) > new Date()) {
    const mins = Math.ceil(
      (new Date(row.locked_until) - Date.now()) / 60000,
    );
    return { error: `Too many attempts. Try again in ${mins} minute(s).` };
  }

  const ok = await verifyPassword(password ?? '', row?.password_hash);

  if (!row || !ok || row.disabled) {
    if (row) {
      const attempts = row.failed_attempts + 1;
      const lock = attempts >= MAX_FAILED;
      await query(
        `UPDATE users SET failed_attempts = $2,
                locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END
          WHERE id = $1`,
        [row.id, lock ? 0 : attempts, lock, String(LOCKOUT_MINUTES)],
      );
    }
    return { error: 'Incorrect email or password.' };
  }

  await query(
    `UPDATE users SET failed_attempts = 0, locked_until = NULL,
            last_login_at = now() WHERE id = $1`,
    [row.id],
  );

  return { user: { id: row.id, email: row.email, name: row.name, role: row.role } };
}

// ── Authorisation ───────────────────────────────────────────────────────────

/** Everything. Only an owner manages accounts. */
export const isOwner = (u) => u?.role === 'owner';

/** Every app, but not accounts. */
export const isAdmin = (u) => u?.role === 'owner' || u?.role === 'admin';

/**
 * Whether this user may change this app.
 *
 * An `app_admin` needs an explicit grant; a `viewer` never writes, whatever
 * grants they hold.
 */
export function canEditApp(user, slug) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  if (user.role !== 'app_admin') return false;
  return user.grants?.[slug] === 'app_admin';
}

/** Whether this user may see this app at all. */
export function canViewApp(user, slug) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  return Boolean(user.grants?.[slug]);
}

/** The apps this user should be shown. Null means "all of them". */
export function visibleApps(user) {
  if (isAdmin(user)) return null;
  return Object.keys(user?.grants ?? {});
}

// ── Middleware ──────────────────────────────────────────────────────────────

/** Attaches `req.user`, or 401s. HTML requests are redirected to the login. */
export async function requireAuth(req, res, next) {
  const user = await currentUser(req);

  if (!user) {
    if ((req.get('accept') ?? '').includes('text/html')) {
      return res.redirect('/login');
    }
    return res.status(401).json({ error: 'unauthenticated' });
  }

  req.user = user;
  next();
}

export function requireOwner(req, res, next) {
  if (!isOwner(req.user)) {
    return res.status(403).json({ error: 'forbidden', message: 'Owner only.' });
  }
  next();
}

export function requireAdminRole(req, res, next) {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: 'forbidden', message: 'Admins only.' });
  }
  next();
}

/**
 * Double-submit CSRF check on every state-changing request.
 *
 * The session cookie is SameSite=Lax, which already blocks cross-site POSTs
 * from a plain form — this covers the cases Lax does not, and costs one header.
 */
export function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const sent = req.get('x-csrf-token') ?? '';
  const expected = req.user?.csrf ?? '';

  const a = Buffer.from(sent);
  const b = Buffer.from(expected);

  if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(403).json({ error: 'bad_csrf', message: 'Refresh and try again.' });
  }

  next();
}

// ── Audit ───────────────────────────────────────────────────────────────────

/**
 * Records a change. Never throws — an audit write must not be able to fail the
 * operation it describes, or a full disk becomes an outage.
 */
export async function audit(req, action, target = {}, detail = null) {
  try {
    await query(
      `INSERT INTO audit_log (user_id, user_email, action, target_type, target_id, detail, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        req.user?.id ?? null,
        req.user?.email ?? null,
        action,
        target.type ?? null,
        target.id ?? null,
        detail ? JSON.stringify(detail) : null,
        req.ip ?? null,
      ],
    );
  } catch (err) {
    log.warn('Audit write failed', { action, error: err.message });
  }
}
