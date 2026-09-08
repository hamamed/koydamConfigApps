import test from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import { readFileSync } from 'node:fs'
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

/* ------------------------------------------------ the two rendered screens ---

   Both are checked against payloads captured from the live services rather
   than a stub shaped the way the view happens to expect. The first version of
   the settings screen looked for `settings` where the API sends `entries`, so
   it rendered an empty form on every service — a screen that answered 200 and
   showed nothing, which no assertion about status codes would ever catch. */

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')).data

async function bootWith(payloads) {
  const client = {
    call: async (_service, path) => ({ ok: true, status: 200, error: null, data: payloads[path] ?? {} }),
    fanOut: async (path) => config.services.map((service) => ({ service, ok: true, status: 200, data: payloads[path] ?? {}, error: null })),
  }
  const server = createApp({ client }).listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    html: async (path) =>
      (await fetch(`${base}${path}`, { headers: { cookie: `${config.auth.cookieName}=${token()}` } })).text(),
    close: () => new Promise((r) => server.close(r)),
  }
}

test('the settings screen renders the fields the service actually sends', async (t) => {
  const api = await bootWith({ '/settings': fixture('settings') })
  t.after(() => api.close())

  const html = await api.html('/s/bdc/parametres')
  const entries = fixture('settings').flatMap((group) => group.entries)
  assert.ok(entries.length > 20, 'the fixture is a real payload')

  // Every single one, not "some fields rendered".
  for (const entry of entries) {
    assert.ok(html.includes(`id="${entry.key}"`), `${entry.key} has a control`)
  }
  assert.ok(html.includes('Nom du site'), 'and they are labelled, not shown as keys')
})

test('each setting gets the control its type calls for', async (t) => {
  const api = await bootWith({ '/settings': fixture('settings') })
  t.after(() => api.close())

  const html = await api.html('/s/bdc/parametres')
  const byKey = Object.fromEntries(fixture('settings').flatMap((g) => g.entries).map((e) => [e.key, e]))

  // A number with bounds keeps them, and as real attributes: an escaping tag
  // turns min="1" into min=&#34;1&#34;, which a browser ignores — the field
  // looks bounded and accepts anything.
  const maxPages = html.match(/<input id="scraper\.maxPages"[^>]*>/)[0]
  assert.match(maxPages, /type="number"/)
  assert.match(maxPages, new RegExp(`min="${byKey['scraper.maxPages'].min}"`))
  assert.doesNotMatch(html, /min=&#3[04];/, 'the bounds are not escaped into inertness')

  // A select carries its options rather than becoming free text.
  const locale = html.match(/<select id="site\.defaultLocale"[\s\S]*?<\/select>/)[0]
  for (const option of byKey['site.defaultLocale'].options) assert.ok(locale.includes(`value="${option}"`))

  // A boolean is a yes/no.
  assert.match(html.match(/<select id="scraper\.fetchDetails"[\s\S]*?<\/select>/)[0], /Oui[\s\S]*Non/)
})

test('a secret is never printed back, and clearing one is its own decision', async (t) => {
  const api = await bootWith({ '/settings': fixture('settings') })
  t.after(() => api.close())

  const html = await api.html('/s/bdc/parametres')
  const secrets = fixture('settings').flatMap((g) => g.entries).filter((e) => e.type === 'secret')
  assert.equal(secrets.length, 3, 'the fixture has write-only settings')

  for (const entry of secrets) {
    const field = html.match(new RegExp(`<input id="${entry.key.replace('.', '\\.')}"[^>]*>`))[0]
    assert.match(field, /type="password"/, `${entry.key} is write-only`)
    assert.doesNotMatch(field, /value=/, `${entry.key} is not rendered back`)
  }
  // Nothing is configured on the box this was captured from, so each one says
  // so rather than showing an empty box that could mean either.
  assert.equal((html.match(/Aucune clé/g) ?? []).length, secrets.length, 'an unset key says it is unset')
  assert.doesNotMatch(html, /name="clear"/, 'and there is nothing to offer clearing')
})

test('a secret that is set says so, and can be erased on purpose', async (t) => {
  // The same payload with one key stored, which is the state the box will be in
  // once somebody pastes a Google Translate key.
  const withKey = fixture('settings').map((group) => ({
    ...group,
    entries: group.entries.map((entry) =>
      entry.key === 'translation.googleApiKey' ? { ...entry, isSet: true, fromEnvironment: false } : entry,
    ),
  }))
  const api = await bootWith({ '/settings': withKey })
  t.after(() => api.close())

  const html = await api.html('/s/bdc/parametres')
  assert.match(html, /Une clé est enregistrée/, 'the stored key is acknowledged')
  assert.match(html, /name="clear" value="translation\.googleApiKey"/, 'and erasing it is its own tick')

  // Still never printed back, set or not.
  const field = html.match(/<input id="translation\.googleApiKey"[^>]*>/)[0]
  assert.doesNotMatch(field, /value=/)
})

test('the system screen leads with what is wrong', async (t) => {
  const api = await bootWith({ '/system': fixture('system') })
  t.after(() => api.close())

  const html = await api.html('/s/bdc/systeme')
  const report = fixture('system')
  for (const check of report.checks) assert.ok(html.includes(check.id), `${check.id} is reported`)

  // The failing checks sort above the passing ones. A status page where a
  // warning sits below the uptime has to be read carefully to use, and nobody
  // reads one carefully at the moment they need it.
  const problems = report.checks.filter((c) => c.severity !== 'ok')
  const passing = report.checks.filter((c) => c.severity === 'ok')
  if (problems.length > 0 && passing.length > 0) {
    assert.ok(html.indexOf(problems[0].id) < html.indexOf(passing[0].id), 'problems first')
  }

  // The one this exists for: bdc ran a month with its database in no archive
  // while every backup reported success.
  assert.match(html, /Contient cette base/)
  assert.match(html, /hamaprojects-/, 'the archive is named')
  assert.doesNotMatch(html, /\d{10,}/, 'sizes are readable, not raw bytes')
})
