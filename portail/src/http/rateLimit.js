import rateLimit from 'express-rate-limit'

const WINDOW_MS = 15 * 60 * 1000
const MAX_ATTEMPTS = 10

/**
 * Throttles sign-in attempts.
 *
 * This is now the only door into either service, which cuts both ways: one
 * place to defend, and one place whose absence would expose both. Keyed on the
 * address plus the email so that one person hammering an account cannot lock
 * out an office that shares an outbound IP.
 */
export const createLoginLimiter = () =>
  rateLimit({
    windowMs: WINDOW_MS,
    limit: MAX_ATTEMPTS,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${req.ip}|${String(req.body?.email ?? '').toLowerCase()}`,
    message: { success: false, error: 'Trop de tentatives. Réessayez dans quelques minutes.' },
  })
