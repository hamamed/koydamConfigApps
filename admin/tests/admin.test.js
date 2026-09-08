import test from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import { createApp } from '../src/app.js'
import { config } from '../src/config/index.js'

/**
 * The administration console.
 *
 * It owns no data, so every test here is about the two things it is actually
 * responsible for: who gets in, and what it does when a service it reports on
 * does not answer.
 */

const SECRET = process.env.JWT_SECRET
const token = (role = 'admin', email = 'a@civictrust.ma') =>
  jwt.sign({ sub: '1', email, role, name: 'Admin' }, SECRET, { expiresIn: '12h' })

/** A client standing in for both services, recording what it was asked. */
function stubClient({ fail = false } = {}) {
  const calls = []
  const answer = (service, path) => {
    calls.push({ service: service.key, path })
    if (fail) return { ok: false, status: 0, data: null, error: `${service.label} is unreachable (timed out)` }
    const data =
      path === '/dashboard'
        ? { counts: { consultations: 3500 }, recentJobs: [], lastRun: { finishedAt: '2026-09-08T05:52:00Z' }, health: { severity: 'ok' } }
        : path === '/system'
          ? { backup: { fresh: true } }
          : path === '/settings'
            ? [{ group: 'scraper', settings: [{ key: 'scraper.delayMs', label: 'Délai', value: '1500' }] }]
            : []
    return { ok: true, status: 200, data, error: null }
  }
  return {
    calls,
    call: async (service, path) => answer(service, path),
    fanOut: async (path) => config.services.map((service) => ({ service, ...answer(service, path) })),
  }
}

async function boot(options) {
  const client = stubClient(options)
  const server = createApp({ client }).listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    client,
    open: (path, role = 'admin') =>
      fetch(`${base}${path}`, { redirect: 'manual', headers: role ? { cookie: `${config.auth.cookieName}=${token(role)}` } : {} }),
    close: () => new Promise((r) => server.close(r)),
  }
}

test('an anonymous visitor is sent to the portal, and brought back here', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  const response = await api.open('/s/bdc/dashboard', null)
  assert.equal(response.status, 302)
  const away = response.headers.get('location')
  assert.match(away, /\/login\?next=/)
  assert.match(decodeURIComponent(away), /admin\.civictrust\.ma\/s\/bdc\/dashboard$/, 'back to the screen they wanted')
})

test('an ordinary account is turned away here, not left to collect errors', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  const response = await api.open('/', 'user')
  assert.equal(response.status, 403)
  assert.match(await response.text(), /administrateurs/i)

  // And nothing was asked of the services on their behalf: letting them in to
  // watch each panel fail its own permission check would be a worse way to say
  // the same thing, and it would spend requests to say it.
  assert.deepEqual(api.client.calls, [])
})

test('the overview reads both services, and says which one it read', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  const html = await (await api.open('/')).text()
  for (const service of config.services) assert.match(html, new RegExp(service.label))
  assert.deepEqual(
    [...new Set(api.client.calls.map((c) => c.service))].sort(),
    config.services.map((s) => s.key).sort(),
    'every configured service was asked',
  )
})

test('a service that is down is reported, not rendered as zeroes', async (t) => {
  const api = await boot({ fail: true })
  t.after(() => api.close())

  const html = await (await api.open('/')).text()
  // "Nothing is happening" and "this service is not answering" are different
  // facts, and a console that shows the first when it means the second is
  // worse than no console.
  assert.match(html, /unreachable|injoignable/i)
  assert.doesNotMatch(html, /<b class="ltr">0<\/b>/, 'no invented counts')
})

test('one service being down does not take the console with it', async (t) => {
  const api = await boot({ fail: true })
  t.after(() => api.close())

  for (const path of ['/', '/s/bdc/dashboard', '/s/marches/systeme', '/s/bdc/parametres']) {
    const response = await api.open(path)
    assert.equal(response.status, 200, `${path} still answers`)
  }
})

test('every screen the console offers is reachable', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  for (const service of config.services) {
    for (const screen of ['dashboard', 'systeme', 'parametres', 'comptes']) {
      const response = await api.open(`/s/${service.key}/${screen}`)
      assert.equal(response.status, 200, `/s/${service.key}/${screen}`)
    }
  }
})

test('an unknown service is a 404, not a call to nowhere', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  assert.equal((await api.open('/s/nope/dashboard')).status, 404)
  assert.deepEqual(api.client.calls, [], 'and nothing was requested for it')
})

test('a blank secret is left alone rather than saved as empty', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  const sent = []
  api.client.call = async (service, path, options) => {
    sent.push({ path, method: options?.method, body: options?.body })
    return { ok: true, status: 200, data: [], error: null }
  }

  await fetch(`${api.base}/s/bdc/parametres`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      cookie: `${config.auth.cookieName}=${token()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ 'scraper.delayMs': '2000', 'translation.apiKey': '' }).toString(),
  })

  const patch = sent.find((call) => call.method === 'PATCH')
  assert.ok(patch, 'the change was sent on')
  assert.equal(patch.body['scraper.delayMs'], '2000')
  // A write-only field submitted empty means "leave it", never "clear it" —
  // otherwise saving one setting wipes an API key on the same page silently.
  assert.ok(!('translation.apiKey' in patch.body), 'the untouched secret was not sent')
})

test('the console forwards the caller’s own session, never a credential of its own', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  const seen = []
  api.client.call = async (service, path, options) => {
    seen.push(options?.token)
    return { ok: true, status: 200, data: {}, error: null }
  }
  api.client.fanOut = async (path, options) => {
    seen.push(options?.token)
    return config.services.map((service) => ({ service, ok: true, status: 200, data: {}, error: null }))
  }

  await api.open('/s/bdc/dashboard')
  assert.equal(seen.length, 1)
  // The person's own token. A service therefore still authorises the actual
  // administrator, and removing them on the portal closes this door too —
  // there is no machine credential here to remember to revoke.
  const payload = jwt.verify(seen[0], SECRET)
  assert.equal(payload.email, 'a@civictrust.ma')
  assert.equal(payload.role, 'admin')
})
