import test from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import { createApp } from '../src/app.js'
import { createTestContainer, startTestServer } from './helpers.js'

/**
 * The shared CivicTrust session.
 *
 * The portal is the account authority; this service verifies the token it
 * issues with the same secret and resolves it to a row in its own database.
 * These tests forge tokens directly with that secret, which is exactly what the
 * portal does — there is no other handshake to imitate.
 */

const SECRET = process.env.JWT_SECRET
const COOKIE = 'mp_token'

/** A session as the portal would issue it: no id of ours, only an address. */
const portalToken = ({ email, role = 'user', name = null, sub = '4242' }) =>
  jwt.sign({ sub, email, role, name, svc: ['bdc', 'marches'], iss: 'portail' }, SECRET, { expiresIn: '12h' })

async function boot() {
  const container = await createTestContainer({})
  const server = await startTestServer(createApp(container))
  return {
    ...server,
    container,
    open: (path, token) =>
      fetch(`${server.base}${path}`, {
        redirect: 'manual',
        headers: token ? { cookie: `${COOKIE}=${token}` } : {},
      }),
  }
}

test('a session from the portal is accepted, and becomes a local account on first sight', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  assert.equal(await api.container.repositories.users.countAll(), 0, 'no accounts to begin with')

  const response = await api.open('/panel', portalToken({ email: 'New.Person@civictrust.ma', name: 'New Person' }))
  assert.equal(response.status, 200, 'admitted without ever having signed in here')

  // Every foreign key in this schema points at a local row, so one has to exist.
  const created = await api.container.repositories.users.findByEmail('new.person@civictrust.ma')
  assert.ok(created, 'a local row was created from the address')
  assert.equal(created.full_name, 'New Person')
  assert.equal(created.role, 'user')
})

test('the local row is reused, not duplicated, on every later request', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  const token = portalToken({ email: 'repeat@civictrust.ma' })
  for (let i = 0; i < 3; i += 1) assert.equal((await api.open('/panel', token)).status, 200)

  assert.equal(await api.container.repositories.users.countAll(), 1, 'one account, not three')
})

test('the portal is authoritative for the role, so a promotion arrives here too', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  await api.open('/panel', portalToken({ email: 'boss@civictrust.ma', role: 'user' }))
  const asUser = await api.open('/panel/settings', portalToken({ email: 'boss@civictrust.ma', role: 'user' }))
  assert.equal(asUser.status, 302, 'an ordinary account cannot open the settings')

  const asAdmin = await api.open('/panel/settings', portalToken({ email: 'boss@civictrust.ma', role: 'admin' }))
  assert.equal(asAdmin.status, 200, 'and the same person promoted on the portal can')

  const row = await api.container.repositories.users.findByEmail('boss@civictrust.ma')
  assert.equal(row.role, 'admin', 'the local row followed')
})

test('a token signed with another secret is refused', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  const forged = jwt.sign({ sub: '1', email: 'attacker@example.com', role: 'admin' }, 'not-the-shared-secret')
  const response = await api.open('/panel', forged)

  assert.equal(response.status, 302, 'sent away to sign in')
  assert.match(response.headers.get('location'), /\/login\?next=/)
  assert.equal(await api.container.repositories.users.countAll(), 0, 'and no account was created for it')
})

test('an expired session is refused rather than silently renewed', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  const stale = jwt.sign({ sub: '1', email: 'someone@civictrust.ma', role: 'user' }, SECRET, { expiresIn: '-1h' })
  assert.equal((await api.open('/panel', stale)).status, 302)
})

test('an account deactivated here is refused even with a valid portal session', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  const token = portalToken({ email: 'gone@civictrust.ma' })
  assert.equal((await api.open('/panel', token)).status, 200)

  const row = await api.container.repositories.users.findByEmail('gone@civictrust.ma')
  await api.container.repositories.users.update(row.id, { is_active: 0 })

  // A shared sign-in must not take away this service's own ability to shut
  // somebody out of it.
  assert.equal((await api.open('/panel', token)).status, 302)
})

test('the session cookie is scoped so it reaches the other services', async (t) => {
  const { cookieOptions } = await import('../src/http/middleware/rateLimit.js')
  const { config } = await import('../src/config/index.js')

  // In the tests there is no domain, because everything is 127.0.0.1 and a
  // domain attribute would make the browser drop the cookie outright. What
  // matters here is that the setting is wired through rather than hardcoded,
  // and that sameSite stays 'lax' — 'strict' withholds the cookie on exactly
  // the navigation that brings somebody here from the portal.
  assert.equal(cookieOptions.sameSite, 'lax')
  assert.equal(cookieOptions.domain, config.auth.cookieDomain ?? undefined)
  assert.equal(cookieOptions.httpOnly, true)
})

test('the sidebar offers a way out of this space', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  const html = await (await api.open('/panel', portalToken({ email: 'someone@civictrust.ma' }))).text()
  const sidebar = html.slice(html.indexOf('<div class="bottom">'), html.indexOf('</aside>'))

  // Two separate applications on two separate procedures: moving between them
  // is a link out, and the portal is where the choice is actually made.
  assert.match(sidebar, /class="switch" href="https?:\/\/[^"]+"/, 'a link to the sibling service')
  assert.equal((sidebar.match(/class="switch"/g) ?? []).length, 2, 'and one to the portal')

  const { config } = await import('../src/config/index.js')
  assert.ok(sidebar.includes(config.auth.portalUrl), 'the portal by its configured address')
  assert.ok(sidebar.includes(config.auth.siblingUrl), 'the sibling by its configured address')
  // Named by what they are, not "the other one".
  assert.doesNotMatch(sidebar, /nav\.(sibling|portal)/, 'labels resolve rather than falling back to the key')
})
