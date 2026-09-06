import { randomBytes } from 'node:crypto'
import { serializeRow, serializeRows } from './serializers.js'
import { NotFoundError, ValidationError } from '../utils/errors.js'
import { clean } from '../utils/text.js'
import { nowIso } from '../utils/dates.js'
import { logger } from '../utils/logger.js'

const log = logger.child('[access]')

const MAX_FIELD = 200
const MAX_REASON = 1000
/** One address may ask this many times a day. The IP rate limiter is separate. */
const MAX_PER_DAY = 3
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Requests for an account.
 *
 * Account creation is an administrator action and always has been. This does
 * not change that: it gives the administrator a queue instead of an inbox, and
 * gives the person asking a form instead of guessing what to write.
 */
export function createAccessRequestService({ accessRequests, users, auth, mailer, settings }) {
  /**
   * @param {object} input the public form's fields.
   * @param {{ip?: string, trap?: string}} context `trap` is the honeypot field:
   *   a real browser leaves it empty because it is hidden, and a bot fills it
   *   in because it fills everything in.
   */
  async function submit(input, { ip = null, trap = '' } = {}) {
    // Accepted, then dropped. Telling a bot it was caught teaches it the shape
    // of the trap; the human who never sees the field is unaffected either way.
    if (clean(trap) !== '') {
      log.warn('honeypot tripped', { ip })
      return { received: true }
    }

    const fullName = required(input.fullName, 'fullName', MAX_FIELD)
    const email = required(input.email, 'email', MAX_FIELD).toLowerCase()
    if (!EMAIL.test(email)) throw new ValidationError('A valid email address is required')

    const record = {
      full_name: fullName,
      email,
      company: optional(input.company, MAX_FIELD),
      ice: optional(input.ice, 40),
      phone: optional(input.phone, 40),
      reason: optional(input.reason, MAX_REASON),
      source_ip: ip,
    }

    // Both of these answer "received" rather than "you already asked". Whether
    // an address has an account here, or a request pending, is not something a
    // form should confirm to whoever types it in.
    if (await users.findByEmail(email)) {
      log.info('request from an address that already has an account', { email })
      return { received: true }
    }
    if (await accessRequests.pendingForEmail(email)) return { received: true }

    const since = new Date(Date.now() - 86_400_000).toISOString()
    if ((await accessRequests.countSince(email, since)) >= MAX_PER_DAY) {
      log.warn('address over the daily cap', { email })
      return { received: true }
    }

    await accessRequests.create(record)
    log.info('access requested', { email, company: record.company })
    return { received: true }
  }

  const pending = async () => serializeRows(await accessRequests.listPending())
  const recent = async (limit) => serializeRows(await accessRequests.listRecent(limit))
  const countPending = () => accessRequests.countPending()

  /**
   * Turns a request into an account.
   *
   * The generated password is returned once, to the administrator, and never
   * stored in readable form — bcrypt is all that is kept. With a mail server
   * configured it is also sent to the person; without one it is shown in the
   * panel and has to be passed on by hand, which is honest about what the box
   * can currently do rather than silently delivering nothing.
   */
  async function approve(id, reviewer, { role = 'user' } = {}) {
    const request = await accessRequests.findById(id)
    if (!request) throw new NotFoundError(`Access request ${id}`)
    if (request.status !== 'pending') throw new ValidationError('That request has already been reviewed')
    if (await users.findByEmail(request.email)) {
      throw new ValidationError('An account already exists for that address')
    }

    const password = generatePassword()
    const created = await auth.register({
      email: request.email,
      password,
      fullName: request.full_name,
      role,
    })
    const user = created.user ?? created
    const reviewed = await accessRequests.review(id, {
      status: 'approved', reviewedBy: reviewer?.id ?? null, userId: user.id,
    })

    let delivered = false
    try {
      const result = await mailer.send({
        to: request.email,
        subject: await subject(),
        text: welcomeText({ request, password, baseUrl: await siteUrl() }),
      })
      delivered = result.channel === 'email'
    } catch (error) {
      // A failed send must not undo an account that was created successfully.
      log.error('could not send the welcome message', { email: request.email, message: error.message })
    }

    return { request: serializeRow(reviewed), user: serializeRow(user), password, delivered }
  }

  async function reject(id, reviewer, note) {
    const request = await accessRequests.findById(id)
    if (!request) throw new NotFoundError(`Access request ${id}`)
    if (request.status !== 'pending') throw new ValidationError('That request has already been reviewed')
    return serializeRow(
      await accessRequests.review(id, {
        status: 'rejected', reviewNote: optional(note, MAX_REASON), reviewedBy: reviewer?.id ?? null,
      }),
    )
  }

  const subject = async () => `${await settings.get('site.name')} — ${'votre accès'}`
  const siteUrl = async () => process.env.PUBLIC_URL || 'https://bdc.civictrust.ma'

  const welcomeText = ({ request, password, baseUrl }) =>
    [
      `Bonjour ${request.full_name},`,
      '',
      'Votre demande d’accès a été acceptée.',
      '',
      `Adresse : ${baseUrl}/login`,
      `Identifiant : ${request.email}`,
      `Mot de passe provisoire : ${password}`,
      '',
      'Changez-le à votre première connexion.',
      `Créé le ${nowIso().slice(0, 10)}.`,
    ].join('\n')

  return { submit, pending, recent, countPending, approve, reject }
}

function required(value, field, max) {
  const cleaned = clean(value)
  if (!cleaned) throw new ValidationError(`${field} is required`)
  if (cleaned.length > max) throw new ValidationError(`${field} must be ${max} characters or fewer`)
  return cleaned
}

const optional = (value, max) => {
  const cleaned = clean(value)
  return cleaned ? cleaned.slice(0, max) : null
}

/**
 * A password nobody has to invent. base64url of 12 random bytes: 96 bits, well
 * past anything the login rate limiter would let through, and still short
 * enough to read down a phone line.
 */
const generatePassword = () => randomBytes(12).toString('base64url')
