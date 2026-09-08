import { Router } from 'express'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { optionalAuth } from '../middleware/auth.js'
import { createAccessRequestLimiter } from '../middleware/rateLimit.js'
import { contentFor } from '../../content/index.js'
import { parseFilters } from '../filters.js'
import { parsePagination } from '../../utils/pagination.js'
import { NotFoundError } from '../../utils/errors.js'
import { exportFilename, toCsv } from '../../utils/csv.js'
import { config } from '../../config/index.js'

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
    publicData: await services.settings.get('site.publicData'),
  })

  /**
   * There is one front door for the CivicTrust services and it is not here:
   * the portal is the front door, it describes both procedures side by side,
   * and it is where the session is created. Two landing pages competing to
   * explain the same family of services is how they drift apart.
   *
   * Somebody already signed in goes straight to their work instead.
   */
  router.get('/', withUser, (req, res) =>
    res.redirect(req.user ? '/panel' : config.auth.portalUrl),
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
   * The open-data pages.
   *
   * Everything they show was published by the Moroccan administration on a
   * public portal; this decides whether this copy of it is public too. The
   * switch is a setting rather than a deploy, and it is read per request, so
   * turning it off closes these pages on the next click.
   */
  const publicData = asyncHandler(async (req, _res, next) => {
    if (!(await services.settings.get('site.publicData'))) throw new NotFoundError('Open data')
    next()
  })

  /** How the crawler is doing, without any of the operational detail the
   *  System screen carries — no disk, no backups, no versions. */
  router.get(
    '/status',
    withUser,
    asyncHandler(async (req, res) => {
      res.render('public/status', { ...(await shell(req)), status: await services.public.status() })
    }),
  )

  router.get(
    '/awards',
    publicData,
    withUser,
    asyncHandler(async (req, res) => {
      const filters = parseFilters(req.query)
      const pagination = parsePagination(req.query)
      const { data, total } = await services.consultations.searchResults(filters, {
        ...pagination,
        sort: req.query.sort,
      })
      res.render('public/awards', {
        ...(await shell(req)),
        rows: data, total, pagination, query: req.query,
      })
    }),
  )

  router.get(
    '/buyers/:name',
    publicData,
    withUser,
    asyncHandler(async (req, res) => {
      const name = decodeURIComponent(req.params.name)
      const buyer = await services.analytics.buyer(name, services.consultations)
      if (buyer.avis.total === 0 && buyer.awards.total === 0) throw new NotFoundError(`Buyer ${name}`)
      res.render('public/profile', { ...(await shell(req)), profile: publicBuyer(buyer), kind: 'buyer' })
    }),
  )

  router.get(
    '/companies/:name',
    publicData,
    withUser,
    asyncHandler(async (req, res) => {
      const name = decodeURIComponent(req.params.name)
      const company = await services.analytics.company(name, services.consultations)
      if (company.awards === 0) throw new NotFoundError(`Company ${name}`)
      res.render('public/profile', { ...(await shell(req)), profile: publicCompany(company), kind: 'company' })
    }),
  )

  router.get(
    '/data',
    publicData,
    withUser,
    asyncHandler(async (req, res) => {
      res.render('public/data', { ...(await shell(req)), stats: await services.public.stats() })
    }),
  )

  /**
   * Bulk download. Capped at EXPORT_LIMIT rows: past that this stops being a
   * download and becomes a way to make the box do work for somebody, and the
   * same data is public at its source.
   */
  const csv = (name, load, columns) =>
    router.get(
      `/data/${name}.csv`,
      publicData,
      asyncHandler(async (req, res) => {
        const { data } = await load(parseFilters(req.query))
        res.setHeader('Content-Type', 'text/csv; charset=utf-8')
        res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(name)}"`)
        res.send(toCsv(columns, data))
      }),
    )

  csv(
    'awards',
    (filters) => services.consultations.searchResults(filters, { limit: EXPORT_LIMIT, offset: 0 }),
    PUBLIC_AWARD_COLUMNS,
  )
  csv(
    'notices',
    (filters) => services.consultations.search(filters, { limit: EXPORT_LIMIT, offset: 0 }),
    PUBLIC_NOTICE_COLUMNS,
  )

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
        'Allow: /status',
        'Allow: /data',
        'Allow: /awards',
        'Allow: /buyers',
        'Allow: /companies',
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
    const urls = ['', '/guide', '/privacy', '/terms', '/request-access', '/status', '/data', '/awards'].flatMap((path) =>
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

/** Rows per bulk download. The same data is public at its source; this is a
 *  convenience, not a mirror-building service. */
const EXPORT_LIMIT = 5000

const PUBLIC_AWARD_COLUMNS = [
  { key: 'reference', label: 'Référence' },
  { key: 'objet', label: 'Objet' },
  { key: 'acheteur', label: 'Acheteur' },
  { key: 'attributaire', label: 'Attributaire' },
  { key: 'montant_attribue', label: 'Montant' },
  { key: 'currency', label: 'Devise' },
  { key: 'nombre_offres', label: 'Devis reçus' },
  { key: 'date_publication_resultat', label: 'Publié le' },
  { key: 'result_status', label: 'Statut' },
]

const PUBLIC_NOTICE_COLUMNS = [
  { key: 'reference', label: 'Référence' },
  { key: 'objet', label: 'Objet' },
  { key: 'acheteur', label: 'Acheteur' },
  { key: 'categorie', label: 'Catégorie' },
  { key: 'lieu_execution', label: 'Lieu' },
  { key: 'date_publication', label: 'Publié le' },
  { key: 'date_limite', label: 'Date limite' },
  { key: 'status', label: 'État' },
  { key: 'motif_annulation', label: 'Motif d’annulation' },
  { key: 'source_url', label: 'Source' },
]

/** The buyer profile, reduced to the shape the shared public view renders. */
const publicBuyer = (buyer) => ({
  name: buyer.name,
  since: buyer.avis.firstSeen,
  stats: [
    { label: 'buyer.avis', value: buyer.avis.total },
    { label: 'buyer.open', value: buyer.avis.open },
    { label: 'buyer.cancelled', value: buyer.cancellationRate === null ? '—' : `${buyer.cancellationRate} %` },
    { label: 'buyer.awards', value: buyer.awards.total },
    { label: 'buyer.median', value: buyer.awards.median ?? '—' },
    { label: 'buyer.bids', value: buyer.awards.avgBids ?? '—' },
    { label: 'buyer.unsuccessful', value: buyer.unsuccessfulRate === null ? '—' : `${buyer.unsuccessfulRate} %` },
    { label: 'buyer.suppliers', value: buyer.awards.winners },
  ],
  relatedTitle: 'buyer.topWinners',
  relatedLabel: 'insights.company',
  relatedPath: '/companies',
  related: buyer.winners,
  note: 'buyer.note',
  awards: buyer.recentAwards,
})

const publicCompany = (company) => ({
  name: company.name,
  since: company.firstSeen,
  stats: [
    { label: 'company.awards', value: company.awards },
    { label: 'company.buyers', value: company.buyers },
    { label: 'company.total', value: company.totalAmount ?? '—' },
    { label: 'company.median', value: company.median ?? '—' },
    { label: 'company.smallest', value: company.min ?? '—' },
    { label: 'company.largest', value: company.max ?? '—' },
    { label: 'company.bids', value: company.avgBids ?? '—' },
  ],
  relatedTitle: 'company.topBuyers',
  relatedLabel: 'insights.buyer',
  relatedPath: '/buyers',
  related: company.topBuyers,
  note: 'company.note',
  awards: company.recentAwards,
})
