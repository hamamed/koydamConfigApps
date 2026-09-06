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
      res.render('panel/consultation', await shell(req, { active: 'projects', consultation, favorite }))
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
        await services.settings.update(req.body, req.user.id)
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

/** Prevents open redirects through the `next` parameter. */
const safeRedirect = (value) =>
  typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/panel'
