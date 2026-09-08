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

  // Read back the way the console reads it: over the admin API, which is the
  // only route into the queue now that the page moved.
  const queue = await (await fetch(`${api.base}/admin/api/requests`, { headers: { cookie: api.cookie } })).json()
  const names = queue.data.pending.map((row) => `${row.full_name} ${row.email}`)
  assert.ok(names.some((n) => n.includes('Amina Berrada') && n.includes('amina@example.ma')))
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

  // The queue moved to the console, which reads it over the admin API. The
  // page is gone from this service; the API is what has to refuse.
  const page = await fetch(`${api.base}/panel/requests`, { headers: { cookie }, redirect: 'manual' })
  assert.equal(page.status, 404, 'the page is not served here any more')

  const api404 = await fetch(`${api.base}/admin/api/requests`, { headers: { cookie } })
  assert.equal(api404.status, 403, 'and the API refuses an ordinary account')

  assert.equal((await api.container.services.accessRequests.pending()).length, 1, 'nothing was approved')
})

test('a request missing what it needs is refused, and says why', async (t) => {
  const api = await site()
  t.after(() => api.close())

  const bad = await fetch(`${api.base}/request-access`, form({ fullName: 'No Mail', email: 'not-an-address' }))
  assert.equal(bad.status, 400)
  assert.match(await bad.text(), /valid email/i)
  assert.equal((await api.container.services.accessRequests.pending()).length, 0)
})
