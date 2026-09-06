import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { createTestContainer, startTestServer } from './helpers.js'
import { CONTENT, CONTENT_LOCALES } from '../src/content/index.js'

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

const get = (base, path, cookie) =>
  fetch(`${base}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} })

test('the front door is a page, not a redirect into the login form', async (t) => {
  const api = await site()
  t.after(() => api.close())

  const response = await get(api.base, '/')
  assert.equal(response.status, 200, 'signed out')
  const html = await response.text()

  // It says what the service is, and it does not offer a sign-up that does not
  // exist — accounts are an administrator action.
  assert.ok(html.includes(CONTENT.fr.landing.tagline))
  assert.ok(html.includes('/login'), 'sign in is offered')
  assert.ok(!/sign.?up|créer un compte|s’inscrire/i.test(html), 'self-service registration is not')
  assert.ok(html.includes(CONTENT.fr.landing.accessNote))

  // And it is honest about not being the government.
  assert.ok(html.includes(CONTENT.fr.landing.disclaimer))
})

test('a signed-in visitor is offered the panel, not a second sign-in', async (t) => {
  const api = await site()
  t.after(() => api.close())

  const html = await (await get(api.base, '/', api.cookie)).text()
  assert.ok(html.includes(CONTENT.fr.landing.ctaPanel))
  assert.ok(!html.includes(`href="/login?lang=fr"`), 'no sign-in link while signed in')
})

test('the public pages exist in all three languages, and mirror for Arabic', async (t) => {
  const api = await site()
  t.after(() => api.close())

  for (const path of ['/', '/guide', '/privacy', '/terms']) {
    for (const locale of CONTENT_LOCALES) {
      const response = await get(api.base, `${path}?lang=${locale}`)
      assert.equal(response.status, 200, `${path} ${locale}`)
      const html = await response.text()
      assert.ok(html.includes(`lang="${locale}"`), `${path} ${locale} declares its language`)
      assert.ok(
        html.includes(`dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`),
        `${path} ${locale} declares its direction`,
      )
    }
  }
})

test('every public document says the same things in every language', () => {
  // A section that exists in French and not in Arabic is a policy that says
  // something different depending on who reads it.
  const shape = (content) => ({
    features: content.landing.features.length,
    roadmap: content.landing.roadmap.length,
    how: content.landing.how.length,
    guide: content.guide.sections.length,
    privacy: content.privacy.sections.length,
    terms: content.terms.sections.length,
  })
  const reference = shape(CONTENT.fr)
  for (const locale of CONTENT_LOCALES) assert.deepEqual(shape(CONTENT[locale]), reference, locale)

  // And no section is left as an empty heading.
  for (const locale of CONTENT_LOCALES) {
    for (const doc of ['guide', 'privacy', 'terms']) {
      for (const section of CONTENT[locale][doc].sections) {
        assert.ok(section.heading.trim().length > 0, `${locale}/${doc} heading`)
        assert.ok(section.paragraphs.length > 0, `${locale}/${doc}/${section.heading}`)
        for (const paragraph of section.paragraphs) assert.ok(paragraph.trim().length > 20)
      }
    }
  }
})

test('the privacy policy names what the application actually does', async (t) => {
  const api = await site()
  t.after(() => api.close())
  const html = await (await get(api.base, '/privacy')).text()

  // Each of these is a real behaviour of this codebase, and each would be a
  // false statement to omit: morgan runs in 'combined' format in production,
  // which logs the client IP; the session cookie is mp_token; and translation
  // sends article text to Google.
  for (const claim of ['IP', 'mp_token', 'lang', 'bcrypt', 'Google']) {
    assert.ok(html.includes(claim), `the policy mentions ${claim}`)
  }
})

test('robots and the sitemap point at the public pages and away from the panel', async (t) => {
  const api = await site()
  t.after(() => api.close())

  const robots = await (await get(api.base, '/robots.txt')).text()
  for (const blocked of ['/panel', '/admin', '/api', '/login']) {
    assert.match(robots, new RegExp(`Disallow: ${blocked}`), blocked)
  }
  assert.match(robots, /Sitemap: http/)

  const sitemap = await (await get(api.base, '/sitemap.xml')).text()
  assert.match(sitemap, /^<\?xml/)
  assert.equal((sitemap.match(/<loc>/g) ?? []).length, 12, 'four pages in three languages')
  assert.ok(!sitemap.includes('/panel'), 'the panel is not advertised')
})

test('the landing page counts the database rather than claiming a number', async (t) => {
  const api = await site()
  t.after(() => api.close())

  const empty = await (await get(api.base, '/')).text()
  assert.ok(empty.includes('>0<'), 'an empty database says zero')

  await api.container.repositories.consultations.upsert({
    source_id: '1', reference: '1/2026', reference_raw: '1/2026', match_key: '1/2026|x',
    objet: 'Achat', acheteur: 'COMMUNE TEST', status: 'open',
    search_text: 'achat', first_seen_at: 'x', last_seen_at: 'x', created_at: 'x', updated_at: 'x',
  })
  const filled = await (await get(api.base, '/')).text()
  assert.ok(filled.includes('>1<'), 'and one row says one')
})
