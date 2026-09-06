import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { createTestContainer, startTestServer } from './helpers.js'

async function site() {
  const container = await createTestContainer()
  await container.services.auth.register({
    email: 'boss@test.ma', password: 'a-very-long-password', role: 'admin',
  })
  const server = await startTestServer(createApp(container))
  const login = await fetch(`${server.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'boss@test.ma', password: 'a-very-long-password' }),
  })
  return { ...server, container, cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] }
}

const form = (fields) =>
  ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
     body: new URLSearchParams(fields).toString(), redirect: 'manual' })

test('a request from the public form reaches the administrator’s queue', async (t) => {
  const api = await site()
  t.after(() => api.close())

  const response = await fetch(`${api.base}/request-access`, form({
    fullName: 'Amina Berrada', email: 'Amina@Example.MA', company: 'Berrada Fournitures',
    ice: '001234567000089', phone: '0600000000', reason: 'Nous répondons aux bons de commande.',
    website: '',
  }))
  assert.equal(response.status, 200)
  assert.ok((await response.text()).includes('Demande enregistrée'))

  const [queued] = await api.container.services.accessRequests.pending()
  assert.equal(queued.email, 'amina@example.ma', 'the address is normalised')
  assert.equal(queued.full_name, 'Amina Berrada')
  assert.equal(queued.company, 'Berrada Fournitures')
  assert.equal(queued.status, 'pending')

  const panel = await (await fetch(`${api.base}/panel/requests`, { headers: { cookie: api.cookie } })).text()
  assert.ok(panel.includes('Amina Berrada') && panel.includes('amina@example.ma'))
})

test('approving a request creates the account and shows the password once', async (t) => {
  const api = await site()
  t.after(() => api.close())

  await fetch(`${api.base}/request-access`, form({ fullName: 'Youssef', email: 'y@example.ma' }))
  const [queued] = await api.container.services.accessRequests.pending()

  const page = await fetch(`${api.base}/panel/requests/${queued.id}/approve`,
    { ...form({}), headers: { ...form({}).headers, cookie: api.cookie } })
  const html = await page.text()
  assert.equal(page.status, 200)
  assert.ok(html.includes('y@example.ma'))

  // The password is displayed, and it actually signs the new account in.
  const shown = html.match(/<code class="ltr"[^>]*>([^<]+)<\/code>/)
  assert.ok(shown, 'a password is shown')
  const login = await fetch(`${api.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'y@example.ma', password: shown[1] }),
  })
  assert.equal(login.status, 200, 'the password shown is the password set')

  // And it is not recoverable afterwards: only its hash was kept.
  const stored = await api.container.repositories.users.findByEmailWithSecret('y@example.ma')
  assert.ok(stored.password_hash.startsWith('$2'), 'bcrypt')
  assert.ok(!JSON.stringify(stored).includes(shown[1]), 'the plaintext is nowhere in the row')

  assert.equal((await api.container.services.accessRequests.pending()).length, 0, 'and the queue is cleared')
})

test('the form does not confirm who already has an account', async (t) => {
  const api = await site()
  t.after(() => api.close())

  // An address that already exists, and a repeat of a pending request, both
  // answer exactly as a fresh request does. A form that says "you already have
  // an account" is an account-enumeration oracle for anyone who asks it.
  const first = await fetch(`${api.base}/request-access`, form({ fullName: 'Boss', email: 'boss@test.ma' }))
  const body = await first.text()
  assert.equal(first.status, 200)
  assert.ok(body.includes('Demande enregistrée'))
  assert.equal((await api.container.services.accessRequests.pending()).length, 0, 'and nothing was queued')

  await fetch(`${api.base}/request-access`, form({ fullName: 'Z', email: 'z@example.ma' }))
  await fetch(`${api.base}/request-access`, form({ fullName: 'Z', email: 'z@example.ma' }))
  assert.equal((await api.container.services.accessRequests.pending()).length, 1, 'no duplicate queue entries')
})

test('a filled honeypot is accepted and dropped', async (t) => {
  const api = await site()
  t.after(() => api.close())

  const response = await fetch(`${api.base}/request-access`, form({
    fullName: 'Bot', email: 'bot@example.ma', website: 'http://spam.example',
  }))
  assert.equal(response.status, 200, 'the bot is told nothing')
  assert.ok((await response.text()).includes('Demande enregistrée'))
  assert.equal((await api.container.services.accessRequests.pending()).length, 0, 'but nothing is queued')
})

test('the queue is closed to ordinary users', async (t) => {
  const api = await site()
  t.after(() => api.close())
  await api.container.services.auth.register({
    email: 'staff@test.ma', password: 'a-very-long-password', role: 'user',
  })
  const login = await fetch(`${api.base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'staff@test.ma', password: 'a-very-long-password' }),
  })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]

  await fetch(`${api.base}/request-access`, form({ fullName: 'X', email: 'x@example.ma' }))
  const [queued] = await api.container.services.accessRequests.pending()

  for (const path of ['/panel/requests', `/panel/requests/${queued.id}/approve`]) {
    const response = await fetch(`${api.base}${path}`, {
      method: path.endsWith('approve') ? 'POST' : 'GET', headers: { cookie }, redirect: 'manual',
    })
    assert.ok(response.status === 403 || response.status === 302, `${path} is not open to a user`)
  }
  assert.equal((await api.container.services.accessRequests.pending()).length, 1, 'and nothing was approved')
})

test('a request missing what it needs is refused, and says why', async (t) => {
  const api = await site()
  t.after(() => api.close())

  const bad = await fetch(`${api.base}/request-access`, form({ fullName: 'No Mail', email: 'not-an-address' }))
  assert.equal(bad.status, 400)
  assert.match(await bad.text(), /valid email/i)
  assert.equal((await api.container.services.accessRequests.pending()).length, 0)
})
