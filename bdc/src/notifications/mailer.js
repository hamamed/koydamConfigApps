import { config } from '../config/index.js'
import { logger } from '../utils/logger.js'

const log = logger.child('[mail]')

/**
 * Mail delivery.
 *
 * With no SMTP host configured this logs the message and reports success, so
 * the whole alert pipeline — matching, recording, marking sent — runs and can be
 * verified before any credentials exist. That is deliberate: the alternative is
 * a feature that looks like it works and silently delivers nothing, which is the
 * failure mode this project has already been bitten by more than once.
 *
 * `nodemailer` is imported lazily, so a deployment that never sends mail does
 * not need it installed.
 */
export function createMailer(options = {}) {
  const settings = { ...config.mail, ...options }
  let transport = null

  async function getTransport() {
    if (transport) return transport
    const { default: nodemailer } = await import('nodemailer')
    transport = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      auth: settings.user ? { user: settings.user, pass: settings.password } : undefined,
    })
    return transport
  }

  /**
   * @returns {Promise<{delivered: boolean, channel: string}>}
   * @throws when SMTP is configured and the send fails — the caller records that
   *   against the notification rather than dropping it.
   */
  async function send({ to, subject, text, html }) {
    if (!settings.enabled) {
      log.info('mail not configured — logging instead of sending', { to, subject })
      return { delivered: true, channel: 'log' }
    }

    const mailer = await getTransport()
    await mailer.sendMail({ from: settings.from, to, subject, text, html })
    log.info('sent', { to, subject })
    return { delivered: true, channel: 'email' }
  }

  return { send, isConfigured: () => settings.enabled }
}
