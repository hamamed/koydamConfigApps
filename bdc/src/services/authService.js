import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { config } from '../config/index.js'
import { serializeRow } from './serializers.js'
import { ConflictError, UnauthorizedError, ValidationError } from '../utils/errors.js'
import { clean } from '../utils/text.js'

const BCRYPT_ROUNDS = 12
const MIN_PASSWORD_LENGTH = 12
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ROLES = new Set(['admin', 'user'])

export function createAuthService({ users }) {
  /**
   * Creates a user. Passwords are hashed with bcrypt; the plaintext never
   * reaches the database or the logs.
   */
  async function register({ email, password, fullName = null, role = 'user' }) {
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
    return serializeRow(await users.create({ email: normalizedEmail, passwordHash, fullName, role }))
  }

  /**
   * Verifies credentials and issues a JWT.
   *
   * The same generic error is returned for unknown accounts, wrong passwords and
   * deactivated accounts, so the endpoint cannot be used to enumerate users.
   */
  async function login(email, password) {
    const user = await users.findByEmailWithSecret(clean(email).toLowerCase())
    const hash = user?.password_hash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin'
    const passwordMatches = await bcrypt.compare(password ?? '', hash)

    if (!user || !passwordMatches || !user.is_active) throw new UnauthorizedError('Invalid email or password')

    await users.touchLogin(user.id)
    return { token: issueToken(user), user: serializeRow({ ...user, password_hash: undefined }) }
  }

  function issueToken(user) {
    return jwt.sign({ sub: String(user.id), email: user.email, role: user.role }, config.auth.jwtSecret, {
      expiresIn: config.auth.jwtExpiresIn,
    })
  }

  /** @throws {UnauthorizedError} when the token is missing, expired or forged. */
  function verifyToken(token) {
    if (!token) throw new UnauthorizedError()
    try {
      const payload = jwt.verify(token, config.auth.jwtSecret)
      return { id: Number(payload.sub), email: payload.email, role: payload.role }
    } catch {
      throw new UnauthorizedError('Session expired or invalid')
    }
  }

  async function changePassword(userId, currentPassword, newPassword) {
    const user = await users.findByEmailWithSecret((await users.findById(userId))?.email ?? '')
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

  return { register, login, verifyToken, changePassword, issueToken }
}
