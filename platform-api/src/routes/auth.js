import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { audit, createSession, destroySession, signIn } from '../auth.js';
import { safeRedirect } from './sso.js';
import { log } from '../log.js';

/**
 * Sign in and out. The only unauthenticated write in the service.
 */
export const authRouter = Router();

/**
 * Per-IP throttle on top of the per-account lockout in signIn().
 *
 * The two catch different attacks: the account lockout stops someone
 * hammering one password list at one user, this stops a spray across many
 * accounts from one address. Neither alone is enough.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  // Counting only failures means a legitimate person who signs in, out and in
  // again is never throttled.
  skipSuccessfulRequests: true,
  message: {
    error: 'rate_limited',
    message: 'Too many sign-in attempts. Wait a few minutes.',
  },
});

authRouter.post('/api/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body ?? {};

  const result = await signIn(email, password);

  if (result.error) {
    log.warn('Failed sign-in', { email: String(email ?? '').slice(0, 80), ip: req.ip });
    // 401 with a deliberately vague message. Distinguishing "no such account"
    // from "wrong password" turns this form into an account-enumeration tool.
    return res.status(401).json({ error: 'invalid_credentials', message: result.error });
  }

  const { csrf } = await createSession(result.user, req, res);

  req.user = result.user;
  await audit(req, 'auth.login', { type: 'user', id: String(result.user.id) });

  res.json({
    ok: true,
    user: {
      email: result.user.email,
      name: result.user.name,
      role: result.user.role,
    },
    csrf,
    // Where to send them next. Validated against an allowlist — an open
    // redirect here would let someone bounce a freshly signed-in admin to a
    // copy of this page that asks for the password again.
    next: safeRedirect(req.body?.next) ?? '/',
  });
});

authRouter.post('/api/logout', async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
});
