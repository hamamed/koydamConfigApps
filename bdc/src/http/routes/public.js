import { Router } from 'express'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { optionalAuth } from '../middleware/auth.js'
import { createAccessRequestLimiter } from '../middleware/rateLimit.js'
import { contentFor } from '../../content/index.js'

/**
 * The pages anyone can read without an account: the front door, the panel
 * guide, and the two legal documents.
 *
 * Mounted before the panel router so `/` lands here rather than bouncing
 * straight to a login form. A signed-in visitor still sees this page — the
 * header offers the panel instead of a sign-in link — because the policy pages
 * have to stay reachable from inside the product, not only from outside it.
 */
export function publicRoutes({ services }) {
  const router = Router()
  const accessRequestLimiter = createAccessRequestLimiter()
  const withUser = optionalAuth(services.auth)

  /** Locals every public page needs. */
  const shell = async (req) => ({
    user: req.user ?? null,
    content: contentFor(req.locale),
    siteName: await services.settings.get('site.name'),
    operator: await services.settings.get('site.operator'),
    contactEmail: await services.settings.get('site.contactEmail'),
    canonical: `${baseUrl(req)}${req.path}`,
  })

  router.get(
    '/',
    withUser,
    asyncHandler(async (req, res) => {
      res.render('public/landing', {
        ...(await shell(req)),
        // Counted at request time. A landing page that claims a scale it no
        // longer has is worse than one that claims none, and these are four
        // cheap COUNT(*)s against indexed tables.
        stats: await services.public.stats(),
      })
    }),
  )

  /**
   * Asking for an account. Two pages rather than a mailto: the request lands in
   * a queue the administrator can work, with the fields they would otherwise
   * have to ask for in a reply.
   */
  router.get(
    '/request-access',
    withUser,
    asyncHandler(async (req, res) => {
      res.render('public/request-access', { ...(await shell(req)), sent: false, error: null, form: {} })
    }),
  )

  router.post(
    '/request-access',
    accessRequestLimiter,
    withUser,
    asyncHandler(async (req, res) => {
      const locals = await shell(req)
      try {
        await services.accessRequests.submit(req.body, {
          ip: req.ip,
          trap: req.body.website,
        })
        res.render('public/request-access', { ...locals, sent: true, error: null, form: {} })
      } catch (error) {
        res.status(error.statusCode ?? 400).render('public/request-access', {
          ...locals, sent: false, error: error.message, form: req.body,
        })
      }
    }),
  )

  const document = (slug, showContact) =>
    router.get(
      `/${slug}`,
      withUser,
      asyncHandler(async (req, res) => {
        const locals = await shell(req)
        res.render('public/document', { ...locals, doc: locals.content[slug], showContact })
      }),
    )

  document('guide', false)
  document('privacy', true)
  document('terms', true)

  /**
   * The panel is behind a login, so a crawler cannot read it anyway — but it
   * would still spend requests discovering that, and the sign-in and password
   * pages have no business in an index.
   */
  router.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(
      [
        'User-agent: *',
        'Allow: /$',
        'Allow: /guide',
        'Allow: /privacy',
        'Allow: /terms',
        'Allow: /request-access',
        'Disallow: /panel',
        'Disallow: /admin',
        'Disallow: /api',
        'Disallow: /login',
        'Disallow: /forgot',
        'Disallow: /reset',
        '',
        `Sitemap: ${baseUrl(req)}/sitemap.xml`,
        '',
      ].join('\n'),
    )
  })

  /** Four public pages in three languages. Small enough to build per request. */
  router.get('/sitemap.xml', (req, res) => {
    const base = baseUrl(req)
    const urls = ['', '/guide', '/privacy', '/terms', '/request-access'].flatMap((path) =>
      ['fr', 'en', 'ar'].map((lang) => `${base}${path || '/'}?lang=${lang}`),
    )
    res.type('application/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        urls.map((url) => `  <url><loc>${escapeXml(url)}</loc></url>`).join('\n') +
        `\n</urlset>\n`,
    )
  })

  return router
}

/** Honours the proxy headers nginx sets, so links are https and not http. */
function baseUrl(req) {
  const host = req.get('x-forwarded-host') || req.get('host') || ''
  const protocol = req.get('x-forwarded-proto') || req.protocol || 'https'
  return `${protocol}://${host}`
}

const escapeXml = (value) =>
  String(value).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c])
