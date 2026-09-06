import { Router } from 'express'
import { config } from '../../config/index.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import { cookieOptions, createLoginLimiter } from '../middleware/rateLimit.js'
import { ok } from '../../utils/pagination.js'

export function authRoutes({ services }) {
  const router = Router()
  const loginLimiter = createLoginLimiter()

  router.post(
    '/login',
    loginLimiter,
    asyncHandler(async (req, res) => {
      const { token, user } = await services.auth.login(req.body.email, req.body.password)
      res.cookie(config.auth.cookieName, token, cookieOptions)
      res.json(ok({ token, user }))
    }),
  )

  router.post('/logout', (req, res) => {
    res.clearCookie(config.auth.cookieName, { ...cookieOptions, maxAge: undefined })
    res.json(ok({ loggedOut: true }))
  })

  router.get(
    '/me',
    requireAuth(services.auth),
    asyncHandler(async (req, res) => {
      res.json(ok(req.user))
    }),
  )

  /** Account creation is an administrator action, never self-service. */
  router.post(
    '/users',
    requireAdmin(services.auth),
    asyncHandler(async (req, res) => {
      res.status(201).json(ok(await services.auth.register(req.body)))
    }),
  )

  router.post(
    '/password',
    requireAuth(services.auth),
    loginLimiter,
    asyncHandler(async (req, res) => {
      res.json(ok(await services.auth.changePassword(req.user.id, req.body.currentPassword, req.body.newPassword)))
    }),
  )

  return router
}
