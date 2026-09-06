import { logger } from '../utils/logger.js'
import { clean } from '../utils/text.js'

const log = logger.child('[password-reset]')

/**
 * Forgotten-password flow.
 *
 * The request endpoint always reports the same thing, whether or not the
 * address is known. Anything else turns it into a way to ask "does this person
 * have an account here" — and on a procurement tool, who is bidding is itself
 * worth knowing.
 */
export function createPasswordResetService({ users, passwordResets, auth, mailer, baseUrl }) {
  async function request(email, { locale = 'fr' } = {}) {
    const address = clean(email).toLowerCase()
    const user = await users.findByEmailWithSecret(address)

    // Same answer either way, and the same amount of work either way.
    if (!user || !user.is_active) {
      log.info('reset requested for an unknown or disabled account', { address })
      return { accepted: true }
    }

    const { token, expiresAt } = await passwordResets.issue(user.id)
    const link = `${baseUrl}/reset?token=${encodeURIComponent(token)}&lang=${locale}`
    const minutes = passwordResets.LIFETIME_MINUTES

    const subject = 'Réinitialisation de votre mot de passe'
    const text =
      `Une réinitialisation a été demandée pour ${user.email}.\n\n` +
      `Ouvrez ce lien pour choisir un nouveau mot de passe (valable ${minutes} minutes) :\n${link}\n\n` +
      "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : rien n'a changé.\n"

    try {
      await mailer.send({
        to: user.email,
        subject,
        text,
        html: `<p>Une réinitialisation a été demandée pour <strong>${user.email}</strong>.</p>
               <p><a href="${link}">Choisir un nouveau mot de passe</a> (valable ${minutes} minutes).</p>
               <p>Si vous n'êtes pas à l'origine de cette demande, ignorez ce message&nbsp;: rien n'a changé.</p>`,
      })
    } catch (error) {
      // The caller still gets the neutral answer; a mail failure must not tell
      // an attacker that the address exists.
      log.error('could not send the reset email', { message: error.message })
    }

    return { accepted: true }
  }

  /** @returns {Promise<boolean>} whether the link is still good. */
  const isValid = async (token) => Boolean(token && (await passwordResets.findUsable(token)))

  async function complete(token, newPassword) {
    const record = token ? await passwordResets.findUsable(token) : null
    if (!record) return { ok: false, reason: 'invalid' }

    // Throws on a password that is too short, before the token is spent, so a
    // rejected attempt does not burn the link.
    await auth.setPassword(record.user_id, newPassword)
    await passwordResets.consume(record.id)
    log.info('password reset completed', { userId: record.user_id })
    return { ok: true }
  }

  return { request, isValid, complete }
}
