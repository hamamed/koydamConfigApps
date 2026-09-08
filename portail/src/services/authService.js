import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { config } from '../config/index.js'
import { ConflictError, UnauthorizedError, ValidationError } from '../utils/errors.js'
import { clean } from '../utils/text.js'
import { nowIso } from '../utils/dates.js'

const BCRYPT_ROUNDS = 12
const MIN_PASSWORD_LENGTH = 12
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ROLES = new Set(['admin', 'user'])

/**
 * A hash no password can match.
 *
 * Compared against for an unknown email so that a missing account costs the
 * same bcrypt round as a wrong password — otherwise the response time alone
 * says whether an address has an account here.
 */
const IMPOSSIBLE_HASH = '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin'

/**
 * Identity for every service on the domain.
 *
 * The token this issues is what bdc and marches verify; they hold no password
 * of their own any more. Its payload carries the email rather than relying on
 * the row id, because the id is local to whichever database issued it and means
 * nothing in the others — each service resolves its own row from the address.
 */
export function createAuthService({ users, signIns = null }) {
  async function register({ email, password, fullName = null, role = 'user', services = 'bdc,marches' }) {
    const normalizedEmail = clean(email).toLowerCase()
    if (!EMAIL_PATTERN.test(normalizedEmail)) throw new ValidationError('A valid email address is required')
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      throw new ValidationError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    }
    if (!ROLES.has(role)) throw new ValidationError(`role must be one of ${[...ROLES].join(', ')}`)

    if (await users.findByEmailWithSecret(normalizedEmail)) {
      throw new ConflictError('An account already exists for this email address')
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
    const created = await users.create({ email: normalizedEmail, passwordHash, fullName, role, services })
    return strip(created)
  }

  /**
   * Verifies credentials and issues the shared session token.
   *
   * One generic failure for an unknown account, a wrong password and a
   * deactivated one, so this cannot be used to find out who has access.
   */
  async function login(email, password, context = {}) {
    const normalizedEmail = clean(email).toLowerCase()
    const user = await users.findByEmailWithSecret(normalizedEmail)
    const matches = await bcrypt.compare(password ?? '', user?.password_hash ?? IMPOSSIBLE_HASH)

    if (!user || !matches || !user.is_active) {
      await record({ email: normalizedEmail, outcome: 'failed', userId: user?.id ?? null, ...context })
      throw new UnauthorizedError('Invalid email or password')
    }

    await users.touchLogin(user.id)
    await record({ email: normalizedEmail, outcome: 'success', userId: user.id, ...context })
    return { token: issueToken(user), user: strip(user) }
  }

  /**
   * @param {object} user a row carrying email, role, services and full_name.
   * @returns {string} a JWT the other services accept.
   */
  function issueToken(user) {
    return jwt.sign(
      {
        sub: String(user.id),
        email: user.email,
        role: user.role,
        name: user.full_name ?? null,
        // Which services this session may open. Read by the chooser here, and
        // by each service when it decides whether to admit the holder.
        svc: servicesOf(user),
        iss: 'portail',
      },
      config.auth.jwtSecret,
      { expiresIn: config.auth.jwtExpiresIn },
    )
  }

  /** @throws {UnauthorizedError} when the token is missing, expired or forged. */
  function verifyToken(token) {
    if (!token) throw new UnauthorizedError()
    try {
      const payload = jwt.verify(token, config.auth.jwtSecret)
      return {
        id: Number(payload.sub),
        email: payload.email,
        role: payload.role,
        fullName: payload.name ?? null,
        services: Array.isArray(payload.svc) ? payload.svc : [],
      }
    } catch {
      throw new UnauthorizedError('Session expired or invalid')
    }
  }

  async function changePassword(userId, currentPassword, newPassword) {
    const current = await users.findById(userId)
    const user = current ? await users.findByEmailWithSecret(current.email) : null
    if (!user) throw new UnauthorizedError()
    if (!(await bcrypt.compare(currentPassword ?? '', user.password_hash))) {
      throw new UnauthorizedError('Current password is incorrect')
    }
    if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new ValidationError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    }
    await users.update(userId, { password_hash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS) })
    return { updated: true }
  }

  /** Sets a password without checking the old one — administrator resets only. */
  async function setPassword(userId, newPassword) {
    if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new ValidationError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    }
    await users.update(userId, { password_hash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS) })
    return { updated: true }
  }

  async function record({ email, outcome, userId = null, service = null, ip = null, userAgent = null }) {
    if (!signIns) return
    try {
      await signIns.add({ userId, email, outcome, service, ip, userAgent, createdAt: nowIso() })
    } catch {
      // An audit row that cannot be written must not stop somebody signing in.
    }
  }

  return { register, login, verifyToken, changePassword, setPassword, issueToken }
}

/** The services an account may open, as an array. */
export const servicesOf = (user) =>
  String(user?.services ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)

const strip = (user) => {
  if (!user) return null
  const { password_hash: _hash, ...rest } = user
  return { ...rest, services: servicesOf(user) }
}
