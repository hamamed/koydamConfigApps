import test from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import { createSqliteDriver } from '../src/db/drivers/sqlite.js'
import { initDatabase } from '../src/db/init.js'
import { setDb } from '../src/db/index.js'
import { createContainer } from '../src/container.js'
import { createApp } from '../src/app.js'
import { config } from '../src/config/index.js'

const COOKIE = config.auth.cookieName

/** A portal on an in-memory database, with one account ready to sign in. */
async function boot({ services = 'bdc,marches', role = 'admin' } = {}) {
  const db = createSqliteDriver({ file: ':memory:' })
  setDb(db)
  await initDatabase(db)
  const container = createContainer(db)
  await container.services.auth.register({
    email: 'you@civictrust.ma',
    password: 'a-very-long-password',
    fullName: 'Test Person',
    role,
    services,
  })

  const server = createApp(container).listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  const signIn = async (password = 'a-very-long-password') => {
    const response = await fetch(`${base}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'you@civictrust.ma', password }).toString(),
    })
    return { response, cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] }
  }

  const open = (path, cookie) =>
    fetch(`${base}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} })

  return { base, container, signIn, open, close: () => new Promise((r) => server.close(r)) }
}

test('the landing page describes both procedures without a session', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  const html = await (await api.open('/')).text()
  assert.match(html, /Bons de commande/)
  assert.match(html, /Marchés/)
  // Naming the article each space is governed by is the point: they are
  // different procedures, and confusing them is how the wrong rule gets
  // applied. Matched on the numbers rather than the exact phrasing, so
  // rewording the copy does not fail the test that guards the distinction.
  assert.match(html, /Article\s+91/)
  assert.match(html, /Articles\s+38\D{1,4}47/)
  assert.match(html, /prix de référence/i, 'and says which one it belongs to')
})

test('signing in issues a session and lands on the chooser', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  const { response, cookie } = await api.signIn()
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), '/choisir')
  assert.match(cookie, new RegExp(`^${COOKIE}=`))

  const chooser = await (await api.open('/choisir', cookie)).text()
  assert.match(chooser, /Test Person/)
  assert.match(chooser, /aller\/bdc/)
  assert.match(chooser, /aller\/marches/)
})

test('the token carries the address the other services identify people by', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  const { cookie } = await api.signIn()
  const payload = jwt.verify(cookie.split('=')[1], config.auth.jwtSecret)

  // `sub` is this database's row id and means nothing in bdc or marches; the
  // email is what they resolve their own row from.
  assert.equal(payload.email, 'you@civictrust.ma')
  assert.equal(payload.role, 'admin')
  assert.deepEqual(payload.svc, ['bdc', 'marches'])
  assert.equal(payload.iss, 'portail')
})

test('a wrong password is refused, and says no more than that', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  const { response } = await api.signIn('the-wrong-password')
  assert.equal(response.status, 401)
  const html = await response.text()
  // Read the error element itself, not the whole page: the sign-in form's own
  // copy mentions "compte", and asserting against the document would pass or
  // fail on wording that has nothing to do with what is disclosed.
  const message = html.match(/<div class="error">([\s\S]*?)<\/div>/)?.[1]?.trim()
  assert.ok(message, 'the failure is shown')
  assert.match(message, /incorrect/i)
  // One message for a wrong password and for an unknown address, so this
  // cannot be used to find out who has an account.
  assert.doesNotMatch(message, /introuvable|inconnu|n['’]existe/i)
  assert.equal(response.headers.get('set-cookie') ?? '', '', 'and no session is issued')

  // The same wording for an address that has no account at all.
  const unknown = await fetch(`${api.base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'nobody@civictrust.ma', password: 'a-very-long-password' }).toString(),
  })
  const other = (await unknown.text()).match(/<div class="error">([\s\S]*?)<\/div>/)?.[1]?.trim()
  assert.equal(other, message, 'indistinguishable from a wrong password')
})

test('every attempt is recorded, because no other service sees passwords now', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  await api.signIn('the-wrong-password')
  await api.signIn()

  const log = await api.container.repositories.signIns.recent(10)
  assert.deepEqual(
    log.map((row) => row.outcome).sort(),
    ['failed', 'success'],
  )
  assert.ok(log.every((row) => row.email === 'you@civictrust.ma'))
})

test('the chooser offers only the spaces an account may open', async (t) => {
  const api = await boot({ services: 'marches' })
  t.after(() => api.close())

  const { cookie } = await api.signIn()
  const chooser = await (await api.open('/choisir', cookie)).text()
  assert.match(chooser, /aller\/marches/)
  assert.doesNotMatch(chooser, /aller\/bdc/, 'bdc is not offered')

  // And asking for it directly is refused here, rather than by the other
  // service's sign-in page after a confusing round trip.
  assert.equal((await api.open('/aller/bdc', cookie)).status, 403)
})

test('opening a space is a redirect to it, and is recorded', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  const { cookie } = await api.signIn()
  const go = await api.open('/aller/marches', cookie)
  assert.equal(go.status, 302)
  assert.match(go.headers.get('location'), /marches\.civictrust\.ma/)

  const log = await api.container.repositories.signIns.recent(10)
  assert.ok(log.some((row) => row.outcome === 'opened' && row.service === 'marches'))
})

test('an anonymous visitor is sent to sign in and returned where they were going', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  const chooser = await api.open('/choisir')
  assert.equal(chooser.status, 302)
  assert.match(chooser.headers.get('location'), /^\/login\?next=/)

  const direct = await api.open('/aller/bdc')
  assert.equal(direct.status, 302)
  assert.match(decodeURIComponent(direct.headers.get('location')), /next=\/aller\/bdc/)
})

test('`next` cannot be used to bounce somebody off the domain', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  // An absolute URL at a service we front is the normal case now, so the guard
  // has to tell "somewhere we sent them from" apart from "anywhere at all" —
  // including hosts that merely start or end with ours.
  for (const hostile of [
    'https://evil.example',
    '//evil.example',
    'javascript:alert(1)',
    'https://civictrust.ma.evil.example/panel',
    'https://notcivictrust.ma/panel',
    'https://bdc.civictrust.ma.evil.example/panel',
    'http://bdc.civictrust.ma/panel',
  ]) {
    const response = await fetch(`${api.base}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        email: 'you@civictrust.ma',
        password: 'a-very-long-password',
        next: hostile,
      }).toString(),
    })
    assert.equal(response.headers.get('location'), '/choisir', `${hostile} is ignored`)
  }
})

test('a service can send somebody back to where they were going', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  // bdc and marches bounce an unauthenticated visitor here carrying an absolute
  // return address. Dropping it meant signing in worked and then landed you on
  // the chooser to pick the space you had already asked for, which reads as
  // being sent back to the portal for nothing.
  const back = 'https://bdc.civictrust.ma/panel/awards'
  const response = await fetch(`${api.base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'you@civictrust.ma', password: 'a-very-long-password', next: back }).toString(),
  })
  assert.equal(response.headers.get('location'), back)

  // And with a session already in hand, /login is a pass-through rather than a
  // form telling somebody they are signed in.
  const { cookie } = await api.signIn()
  const through = await api.open(`/login?next=${encodeURIComponent(back)}`, cookie)
  assert.equal(through.status, 302)
  assert.equal(through.headers.get('location'), back)
})

test('the CSP lets the sign-in redirect actually land', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  const csp = (await api.open('/login')).headers.get('content-security-policy') ?? ''
  const formAction = csp.split(';').map((part) => part.trim()).find((part) => part.startsWith('form-action'))
  assert.ok(formAction, 'form-action is set')

  // `form-action` is enforced across redirects. With 'self' alone the browser
  // cancels the navigation to bdc *after* the session cookie is set, so signing
  // in looks like it did nothing until you go back and find yourself signed in.
  // curl never sees this — it does not implement CSP — so nothing but this
  // assertion stands between that bug and production.
  for (const service of config.services) {
    assert.ok(formAction.includes(new URL(service.url).origin), `${service.key} is a permitted destination`)
  }
  assert.ok(formAction.includes("'self'"), 'and posting back here still works')

  // Not a wildcard: the point is to name the destinations, not to stop caring.
  assert.doesNotMatch(formAction, /\*/, 'no wildcard')
})

test('signing out clears the session', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  const { cookie } = await api.signIn()
  const out = await fetch(`${api.base}/logout`, { method: 'POST', redirect: 'manual', headers: { cookie } })
  assert.equal(out.status, 302)
  assert.equal(out.headers.get('location'), '/')
  // Cleared by expiry, and with the same attributes it was set with — a
  // clearCookie that omits them removes a different cookie and leaves the
  // shared session alive on the other services.
  assert.match(out.headers.get('set-cookie') ?? '', new RegExp(`${COOKIE}=`))
  assert.match(out.headers.get('set-cookie') ?? '', /Expires=Thu, 01 Jan 1970|Max-Age=0/)
})

test('a signed-in visitor is not shown the pitch again', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  const { cookie } = await api.signIn()
  const landing = await api.open('/', cookie)
  assert.equal(landing.status, 302)
  assert.equal(landing.headers.get('location'), '/choisir')
})

test('the accounts API is one list, and only for administrators', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  const anonymous = await api.open('/admin/api/users')
  assert.equal(anonymous.status, 401)

  const { cookie } = await api.signIn()
  const response = await api.open('/admin/api/users', cookie)
  assert.equal(response.status, 200)

  const { data } = await response.json()
  const account = data.find((row) => row.email === 'you@civictrust.ma')
  assert.ok(account, 'the account is listed')
  assert.equal(account.role, 'admin')
  // Which spaces it may open is decided here, not in either service — that is
  // the whole reason the console reads accounts from the portal rather than
  // from bdc and marches, which only know who has visited them.
  assert.deepEqual(account.services, ['bdc', 'marches'])
  assert.equal(account.isActive, true)
  assert.ok(!('password_hash' in account) && !('passwordHash' in account), 'and no hash leaves here')
})

test('an ordinary account cannot read the accounts', async (t) => {
  const api = await boot({ role: 'user' })
  t.after(() => api.close())

  const { cookie } = await api.signIn()
  assert.equal((await api.open('/admin/api/users', cookie)).status, 403)
})

test('the accounts API accepts a bearer token, not only a cookie', async (t) => {
  const api = await boot()
  t.after(() => api.close())

  const { cookie } = await api.signIn()
  const token = cookie.split('=')[1]

  // How the administration console actually calls this: server to server, on
  // an administrator's behalf, with no cookie jar in between. Reading only the
  // cookie made that arrive anonymous and the accounts screen render empty.
  const response = await fetch(`${api.base}/admin/api/users`, { headers: { Authorization: `Bearer ${token}` } })
  assert.equal(response.status, 200)
  const { data } = await response.json()
  assert.ok(data.some((row) => row.email === 'you@civictrust.ma'))

  // And a bearer token still has to be a real one.
  const forged = await fetch(`${api.base}/admin/api/users`, { headers: { Authorization: 'Bearer not-a-token' } })
  assert.equal(forged.status, 401)
})
