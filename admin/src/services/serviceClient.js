import { config } from '../config/index.js'
import { logger } from '../utils/logger.js'

const log = logger.child('[client]')

/**
 * Talks to a service's own `/admin/api` on behalf of the signed-in person.
 *
 * The caller's session token is forwarded as a bearer credential rather than
 * the console holding one of its own. Two consequences worth having: a service
 * authorises the actual administrator, so its own `requireAdmin` still decides;
 * and removing somebody on the portal closes this door at the same moment it
 * closes the others, with nothing here to remember to revoke.
 */
export function createServiceClient() {
  /**
   * @param {object} service an entry from config.services.
   * @param {string} path a path under /admin/api.
   * @param {object} [options] token, method, body.
   * @returns {Promise<{ok: boolean, status: number, data: any, error: string|null}>}
   *   Never throws. A console that 500s because one of the services it reports
   *   on is down is a console that cannot tell you that service is down.
   */
  async function call(service, path, { token, method = 'GET', body = null } = {}) {
    const url = `${service.api}/admin/api${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs)

    try {
      const response = await fetch(url, {
        method,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })

      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          data: null,
          error: payload?.error ?? `${service.label} answered ${response.status}`,
        }
      }
      return { ok: true, status: response.status, data: payload?.data ?? payload, error: null }
    } catch (error) {
      const reason = error.name === 'AbortError' ? 'timed out' : error.message
      log.warn('service unreachable', { service: service.key, path, reason })
      return { ok: false, status: 0, data: null, error: `${service.label} is unreachable (${reason})` }
    } finally {
      clearTimeout(timer)
    }
  }

  /** The same call against every configured service, in parallel. */
  async function fanOut(path, options) {
    const results = await Promise.all(
      config.services.map(async (service) => ({ service, ...(await call(service, path, options)) })),
    )
    return results
  }

  /**
   * The portal's own admin API, for the accounts.
   *
   * Same shape as `call`, same forwarded token, different host — the portal is
   * not one of the services this console administers, it is where identity
   * lives for all of them.
   */
  async function accounts(path, options) {
    return call({ key: 'portail', label: 'Le portail', api: config.auth.accountsApi }, path, options)
  }

  return { call, fanOut, accounts }
}
