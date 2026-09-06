import { Router } from 'express'
import { config } from '../../config/index.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { requireAdminPage, requireUserPage } from '../middleware/auth.js'
import { cookieOptions, createLoginLimiter } from '../middleware/rateLimit.js'
import { parseFilters } from '../filters.js'
import { parsePagination } from '../../utils/pagination.js'

/**
 * The panel.
 *
 * Two tiers, because they are not the same job:
 *   - anyone signed in browses projects and keeps their own favourites;
 *   - an administrator additionally sees the dashboard, account management and
 *     the settings, all of which change how the site behaves for everyone or
 *     send traffic at a public government service.
 */
export function panelRoutes({ services }) {
  const router = Router()
  const anyUser = requireUserPage(services.auth)
  const adminOnly = requireAdminPage(services.auth)
  const loginLimiter = createLoginLimiter()

  const shell = async (req, extra = {}) => ({
    user: req.user,
    siteName: await services.settings.get('site.name'),
    ...extra,
  })

  // ------------------------------------------------------------------ session
  router.get(
    '/login',
    asyncHandler(async (req, res) => {
      res.render('panel/login', {
        error: null,
        next: safeRedirect(req.query.next),
        email: '',
        siteName: await services.settings.get('site.name'),
      })
    }),
  )

  router.post(
    '/login',
    loginLimiter,
    asyncHandler(async (req, res) => {
      const target = safeRedirect(req.body.next)
      try {
        const { token } = await services.auth.login(req.body.email, req.body.password)
        res.cookie(config.auth.cookieName, token, cookieOptions)
        res.redirect(target)
      } catch (error) {
        res.status(401).render('panel/login', {
          error: error.message,
          next: target,
          email: req.body.email ?? '',
          siteName: await services.settings.get('site.name'),
        })
      }
    }),
  )

  router.get(
    '/forgot',
    asyncHandler(async (req, res) => {
      res.render('panel/forgot', { siteName: await services.settings.get('site.name'), done: false, error: null })
    }),
  )

  router.post(
    '/forgot',
    loginLimiter,
    asyncHandler(async (req, res) => {
      await services.passwordReset.request(req.body.email, { locale: req.locale })
      // Always the same answer, so this cannot be used to find out who has an
      // account. On a procurement tool, who is bidding is itself worth knowing.
      res.render('panel/forgot', { siteName: await services.settings.get('site.name'), done: true, error: null })
    }),
  )

  router.get(
    '/reset',
    asyncHandler(async (req, res) => {
      const valid = await services.passwordReset.isValid(req.query.token)
      res.render('panel/reset', {
        siteName: await services.settings.get('site.name'),
        token: req.query.token ?? '',
        valid,
        done: false,
        error: valid ? null : 'invalid',
      })
    }),
  )

  router.post(
    '/reset',
    loginLimiter,
    asyncHandler(async (req, res) => {
      const siteName = await services.settings.get('site.name')
      const render = (extra) => res.render('panel/reset', { siteName, token: req.body.token ?? '', ...extra })

      if (req.body.password !== req.body.confirm) {
        return render({ valid: true, done: false, error: 'mismatch' })
      }
      try {
        const result = await services.passwordReset.complete(req.body.token, req.body.password)
        if (!result.ok) return render({ valid: false, done: false, error: 'invalid' })
        return render({ valid: false, done: true, error: null })
      } catch (error) {
        return render({ valid: true, done: false, error: error.message })
      }
    }),
  )

  router.post('/logout', (req, res) => {
    res.clearCookie(config.auth.cookieName, { ...cookieOptions, maxAge: undefined })
    res.redirect('/login')
  })

  // ------------------------------------------------------- everyone signed in
  router.get(
    '/panel',
    anyUser,
    asyncHandler(async (req, res) => {
      const filters = parseFilters(req.query)
      const pagination = parsePagination(req.query)
      const { data, total } = await services.consultations.search(
        filters,
        { ...pagination, sort: req.query.sort },
        req.user.id,
      )
      res.render('panel/projects', await shell(req, { active: 'projects', rows: data, total, pagination, query: req.query }))
    }),
  )

  router.get(
    '/panel/consultations/:id',
    anyUser,
    asyncHandler(async (req, res) => {
      const consultation = await services.consultations.getById(Number(req.params.id), req.user.id)
      const favorite = consultation.isFavorite
        ? await services.favorites.find(req.user.id, consultation.id)
        : null
      res.render('panel/consultation', await shell(req, {
        active: 'projects',
        consultation,
        favorite,
        canTranslate: await services.translation.isConfigured(),
      }))
    }),
  )

  router.get(
    '/panel/awards',
    anyUser,
    asyncHandler(async (req, res) => {
      const filters = parseFilters(req.query)
      const pagination = parsePagination(req.query)
      const { data, total } = await services.consultations.searchResults(filters, {
        ...pagination,
        sort: req.query.sort,
      })
      res.render('panel/awards', await shell(req, { active: 'awards', rows: data, total, pagination, query: req.query }))
    }),
  )

  router.get(
    '/panel/alerts',
    anyUser,
    asyncHandler(async (req, res) => {
      res.render('panel/alerts', await shell(req, {
        active: 'alerts',
        searches: await services.savedSearches.list(req.user.id),
        history: await services.savedSearches.history(req.user.id, 25),
        mailConfigured: config.mail.enabled,
        error: null,
      }))
    }),
  )

  router.post(
    '/panel/alerts',
    anyUser,
    asyncHandler(async (req, res) => {
      try {
        // The filters are parsed from the same query vocabulary the listings
        // use, so a search saved from a screen reproduces what was on it.
        await services.savedSearches.create(req.user.id, {
          name: req.body.name,
          filters: parseFilters(req.body),
          notifyNew: req.body.notifyNew === 'on' || req.body.notifyNew === 'true',
          notifyAwards: req.body.notifyAwards === 'on' || req.body.notifyAwards === 'true',
        })
        res.redirect(`/panel/alerts?lang=${req.locale}`)
      } catch (error) {
        res.status(error.statusCode ?? 400).render('panel/alerts', await shell(req, {
          active: 'alerts',
          searches: await services.savedSearches.list(req.user.id),
          history: await services.savedSearches.history(req.user.id, 25),
          mailConfigured: config.mail.enabled,
          error: error.message,
        }))
      }
    }),
  )

  router.get(
    '/panel/invoices',
    anyUser,
    asyncHandler(async (req, res) => {
      const pagination = parsePagination(req.query)
      const scope = req.user.role === 'admin' && req.query.all === 'true' ? {} : { userId: req.user.id }
      const { data, total } = await services.invoices.list(scope, { ...pagination, sort: req.query.sort })
      res.render('panel/invoices', await shell(req, {
        active: 'invoices',
        rows: data,
        total,
        pagination,
        query: req.query,
        notice: req.query.created ? 'created' : null,
      }))
    }),
  )

  /** Builds an invoice from a project's articles. */
  router.get(
    '/panel/consultations/:id/invoice',
    anyUser,
    asyncHandler(async (req, res) => {
      const consultation = await services.consultations.getById(Number(req.params.id), req.user.id)
      res.render('panel/invoice-new', await shell(req, { active: 'invoices', consultation, error: null }))
    }),
  )

  router.post(
    '/panel/consultations/:id/invoice',
    anyUser,
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id)
      try {
        const invoice = await services.invoices.create(req.user.id, buildInvoicePayload(id, req.body))
        res.redirect(`/panel/invoices?created=${invoice.id}&lang=${req.locale}`)
      } catch (error) {
        const consultation = await services.consultations.getById(id, req.user.id)
        res.status(error.statusCode ?? 400).render('panel/invoice-new', await shell(req, {
          active: 'invoices',
          consultation,
          error: [error.message, ...(error.details ?? [])].join(' — '),
        }))
      }
    }),
  )

  router.get(
    '/panel/insights',
    anyUser,
    asyncHandler(async (req, res) => {
      const filters = parseFilters(req.query)
      res.render('panel/insights', await shell(req, {
        active: 'insights',
        insights: await services.analytics.overview(filters),
        query: req.query,
      }))
    }),
  )

  router.get(
    '/panel/favorites',
    anyUser,
    asyncHandler(async (req, res) => {
      const filters = parseFilters(req.query)
      const pagination = parsePagination(req.query)
      const { data, total } = await services.favorites.list(req.user.id, filters, {
        ...pagination,
        sort: req.query.sort,
      })
      res.render('panel/favorites', await shell(req, { active: 'favorites', rows: data, total, pagination, query: req.query }))
    }),
  )

  // ------------------------------------------------------------- admin only
  router.get(
    '/panel/dashboard',
    adminOnly,
    asyncHandler(async (req, res) => {
      res.render('panel/dashboard', await shell(req, { active: 'dashboard', dashboard: await services.admin.dashboard() }))
    }),
  )

  router.get(
    '/panel/users',
    adminOnly,
    asyncHandler(async (req, res) => {
      res.render('panel/users', await shell(req, {
        active: 'users',
        users: await services.users.list(),
        error: null,
        notice: req.query.created ? 'created' : null,
      }))
    }),
  )

  router.post(
    '/panel/users',
    adminOnly,
    asyncHandler(async (req, res) => {
      try {
        await services.users.create({
          email: req.body.email,
          password: req.body.password,
          fullName: req.body.fullName,
          role: req.body.role,
        })
        res.redirect(`/panel/users?created=1&lang=${req.locale}`)
      } catch (error) {
        res.status(error.statusCode ?? 400).render('panel/users', await shell(req, {
          active: 'users',
          users: await services.users.list(),
          error: error.message,
          notice: null,
        }))
      }
    }),
  )

  router.get(
    '/panel/settings',
    adminOnly,
    asyncHandler(async (req, res) => {
      res.render('panel/settings', await shell(req, {
        active: 'settings',
        groups: await services.settings.describe(),
        error: null,
        notice: req.query.saved ? 'saved' : null,
      }))
    }),
  )

  router.post(
    '/panel/settings',
    adminOnly,
    asyncHandler(async (req, res) => {
      try {
        // `clear` carries the keys whose "erase" box was ticked; a checkbox
        // group arrives as a string when one is ticked and an array when more.
        const { clear, ...values } = req.body
        const cleared = clear === undefined ? [] : Array.isArray(clear) ? clear : [clear]
        await services.settings.update(values, req.user.id, { clear: cleared })
        res.redirect(`/panel/settings?saved=1&lang=${req.locale}`)
      } catch (error) {
        res.status(400).render('panel/settings', await shell(req, {
          active: 'settings',
          groups: await services.settings.describe(),
          error: [error.message, ...(error.details ?? [])].join(' — '),
          notice: null,
        }))
      }
    }),
  )

  // Old bookmarks keep working. The /admin ones live in routes/admin.js, on the
  // router that is mounted there.
  router.get('/', (_req, res) => res.redirect('/panel'))

  return router
}

/**
 * Turns the invoice form into the payload the service expects.
 *
 * The form posts parallel arrays — one entry per article, ticked or not —
 * because that is what a checkbox table submits. Only ticked lines with a price
 * become items; the portal publishes no prices, so a blank one is a line the
 * user chose not to quote yet, not an error.
 */
function buildInvoicePayload(consultationId, body) {
  const asArray = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value])
  const included = new Set(asArray(body.include).map(String))

  const items = asArray(body.articleId)
    .map((articleId, index) => ({
      articleId: Number(articleId),
      quantity: Number(asArray(body.quantity)[index]),
      unitPrice: asArray(body.unitPrice)[index],
    }))
    .filter((item) => included.has(String(item.articleId)) && String(item.unitPrice ?? '').trim() !== '')

  return {
    consultationId,
    client: { name: body.clientName, ice: body.clientIce, address: body.clientAddress },
    items,
    taxRate: body.taxRate === '' ? undefined : Number(body.taxRate),
    issueDate: body.issueDate || undefined,
    dueDate: body.dueDate || undefined,
    notes: body.notes,
  }
}

/** Prevents open redirects through the `next` parameter. */
const safeRedirect = (value) =>
  typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/panel'
