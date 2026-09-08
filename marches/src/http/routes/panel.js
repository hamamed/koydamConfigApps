import { Router } from 'express'
import { config } from '../../config/index.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { requireAdminPage, requireUserPage } from '../middleware/auth.js'
import { cookieOptions, clearCookieOptions, createLoginLimiter } from '../middleware/rateLimit.js'
import { parseFilters } from '../filters.js'
import { parsePagination } from '../../utils/pagination.js'
import { NotFoundError } from '../../utils/errors.js'
import { translator } from '../../i18n/index.js'
import { parseAmountToCentimes } from '../../utils/money.js'
import { MARKET_KINDS, classifyKind, computeReferencePrice } from '../../utils/referencePrice.js'

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
    // Rendered by the sidebar on every panel page.
    portalUrl: config.auth.portalUrl,
    siblingUrl: config.auth.siblingUrl,
    adminUrl: config.auth.adminUrl,
    siteName: await services.settings.get('site.name'),
    // Counted for the sidebar badge, and only for the people who can act on it.
    pendingRequests: req.user?.role === 'admin' ? await services.accessRequests.countPending() : 0,
    ...extra,
  })

  // ------------------------------------------------------------------ session
  //
  // Signing in happens on the portal, which is the account authority for every
  // CivicTrust service. These two routes stay as redirects rather than being
  // deleted: a bookmark, an old email link and every `next=` this panel ever
  // produced still point at /login, and a 404 there would look like the service
  // being down.
  router.get('/login', (req, res) => {
    const back = `${config.publicUrl}${safeRedirect(req.query.next)}`
    res.redirect(`${config.auth.portalUrl}/login?next=${encodeURIComponent(back)}`)
  })

  router.post('/login', (_req, res) => res.redirect(`${config.auth.portalUrl}/login`))

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
    // Cleared with the domain and path it was set with, or the browser keeps a
    // different cookie and the session survives on the other services.
    res.clearCookie(config.auth.cookieName, clearCookieOptions)
    res.redirect(config.auth.portalUrl)
  })

  // ------------------------------------------------------- administration
  //
  // Nothing here. The dashboard, the system report, the settings, the accounts
  // and the access-request queue all moved to the console at
  // admin.civictrust.ma, which reaches this service over its own /admin/api
  // with the administrator's own session — so the guard that used to sit on
  // these routes still runs, one layer further out.
  //
  // The API stays exactly where it was. It is what the console is a client of.

  // ------------------------------------------------------- everyone signed in
  /**
   * The home screen: what has changed since you looked, and what runs out next.
   * The listing answers "what exists"; this answers the two questions that
   * decide whether somebody bids in time.
   */
  router.get(
    '/panel/today',
    anyUser,
    asyncHandler(async (req, res) => {
      res.render('panel/today', await shell(req, {
        active: 'today',
        today: await services.today.forUser(req.user),
      }))
    }),
  )

  /** The one-question setup a new account is offered instead of 700 rows. */
  router.post(
    '/panel/today/setup',
    anyUser,
    asyncHandler(async (req, res) => {
      const filters = {}
      if (typeof req.body.categorie === 'string' && req.body.categorie.trim()) filters.categorie = req.body.categorie.trim()
      if (typeof req.body.lieuExecution === 'string' && req.body.lieuExecution.trim()) {
        filters.lieuExecution = req.body.lieuExecution.trim()
      }
      try {
        await services.savedSearches.create(req.user.id, {
          name: translator(req.locale)('today.setupName'),
          filters,
          notifyNew: true,
          notifyAwards: true,
        })
      } catch {
        // A setup that fails must not block the screen it is offered on.
      }
      res.redirect(`/panel/today?lang=${req.locale}`)
    }),
  )

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
    '/panel/alerts',
    anyUser,
    asyncHandler(async (req, res) => {
      res.render('panel/alerts', await shell(req, {
        active: 'alerts',
        searches: await services.savedSearches.list(req.user.id),
        history: await services.savedSearches.history(req.user.id, 25),
        mailConfigured: await services.mailer.isConfigured(),
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
          mailConfigured: await services.mailer.isConfigured(),
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

  /**
   * The reference price of article 44 of décret n° 2-22-431, as a calculator.
   *
   * Standalone on purpose. Article 44 sits in the appel d'offres chapter: the
   * commission, the séance d'ouverture des plis and the prix de référence are
   * that procedure's machinery. Bons de commande — everything this panel
   * crawls — are article 91, where competitors drop off a devis and none of
   * that applies. So the page is a tool the same contractors can use for their
   * marchés, and it is deliberately not wired to any avis in this database.
   */
  router.get(
    '/panel/reference-price',
    anyUser,
    asyncHandler(async (req, res) => {
      // `?from=<id>` is what makes this automatic. The listing does not carry
      // the estimate, so the crawler reads it off each consultation's own
      // detail page — by the time anyone opens this form, the number article 44
      // computes every threshold from is already in the database.
      const source = req.query.from
        ? await services.consultations.getById(Number(req.query.from), req.user.id)
        : null

      res.render('panel/reference-price', await shell(req, {
        active: 'referencePrice',
        form: source ? prefillFromConsultation(source) : blankReferenceForm(),
        source,
        result: null,
        error: null,
      }))
    }),
  )

  router.post(
    '/panel/reference-price',
    anyUser,
    asyncHandler(async (req, res) => {
      const form = readReferenceForm(req.body)
      // Only the banner naming the marché depends on this; a consultation that
      // has since gone must not take the calculation down with it.
      const source = form.sourceId
        ? await services.consultations.getById(form.sourceId, req.user.id).catch(() => null)
        : null

      let result = null
      let error = null
      try {
        result = evaluateReferenceForm(form)
      } catch (failure) {
        error = failure.message
      }

      res.render('panel/reference-price', await shell(req, { active: 'referencePrice', form, source, result, error }))
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

  /**
   * One buyer's record. Addressed by the name the portal prints, which is the
   * only identifier a buyer has anywhere in its markup.
   */
  router.get(
    '/panel/buyers/:name',
    anyUser,
    asyncHandler(async (req, res) => {
      const name = decodeURIComponent(req.params.name)
      const buyer = await services.analytics.buyer(name, services.consultations)
      if (buyer.avis.total === 0 && buyer.awards.total === 0) throw new NotFoundError(`Buyer ${name}`)
      res.render('panel/buyer', await shell(req, { active: 'projects', buyer }))
    }),
  )

  /** The queue behind the public access-request form. */

  const reviewRequest = (action, handler) =>
    router.post(
      `/panel/requests/:id/${action}`,
      adminOnly,
      asyncHandler(async (req, res) => {
        let notice = null
        let error = null
        try {
          notice = await handler(Number(req.params.id), req)
        } catch (failure) {
          error = failure.message
        }
        res.status(error ? 400 : 200).render('panel/requests', await shell(req, {
          active: 'requests',
          pending: await services.accessRequests.pending(),
          history: await services.accessRequests.recent(20),
          notice,
          error,
        }))
      }),
    )

  reviewRequest('approve', async (id, req) => {
    const result = await services.accessRequests.approve(id, req.user)
    // The generated password is shown here once and never again: it is not
    // stored in readable form anywhere, only its bcrypt hash.
    return {
      message: translator(req.locale)('requests.created', { email: result.user.email }),
      password: result.password,
      delivered: result.delivered,
    }
  })

  reviewRequest('reject', async (id, req) => {
    await services.accessRequests.reject(id, req.user, req.body.note)
    return { message: translator(req.locale)('requests.rejected'), password: null, delivered: false }
  })

  /**
   * Every company that has won public work, and how much is known about each.
   * Administrator-only: it exists to review the coverage of the identity
   * registers, which is an operational question rather than a bidder's one.
   */

  /** One company's record — the award side of a buyer profile. */

  /**
   * Recording what is known about a company, and asking the public register
   * for candidates. Both are administrator actions: the register is matched by
   * name alone, so a match is a proposal for a person to accept, never a write.
   */






  // `/` is the public landing page now, served by routes/public.js, which is
  // mounted ahead of this router. The redirect that used to live here would
  // never fire, and leaving it would suggest the front door still bounces
  // straight into the panel.

  return router
}


/* ---------------------------------------------------------------- article 44 */

/**
 * Competitor rows rendered on an empty form. Eight is the number of bidders a
 * bon de commande usually draws; the page can add more without a round trip,
 * and the form keeps whatever was submitted.
 */
const OFFER_ROWS = 8
const MARKET_KIND_VALUES = new Set(Object.values(MARKET_KINDS))

const asArray = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value])

/** Pads a set of competitor rows out to the number the form displays. */
const padRows = (offers) => [
  ...offers,
  ...Array.from({ length: Math.max(0, OFFER_ROWS - offers.length) }, () => ({ name: '', amount: '' })),
]

const blankReferenceForm = () => ({ estimate: '', kind: '', sourceId: null, offers: padRows([]) })

/**
 * Fills the form from a marché the crawler has already read.
 *
 * `categorie` is the portal's own "Travaux / Fournitures / Services", which is
 * exactly the distinction article 44 draws — it decides whether the floor is
 * 20% or 25%. It is still classified rather than trusted, and when it resolves
 * to nothing the user picks.
 */
function prefillFromConsultation(consultation) {
  return {
    estimate: consultation.estimation === null || consultation.estimation === undefined ? '' : String(consultation.estimation),
    kind: classifyKind(consultation.categorie) ?? classifyKind(consultation.procedure_type) ?? '',
    sourceId: consultation.id,
    offers: padRows([]),
  }
}

/** Reads the posted form back, keeping the raw strings so a rejected submission re-renders as typed. */
function readReferenceForm(body = {}) {
  const sourceId = Number(body.sourceId)
  const names = asArray(body.name)
  const amounts = asArray(body.amount)
  const offers = amounts.map((amount, index) => ({
    name: String(names[index] ?? ''),
    amount: String(amount ?? ''),
  }))

  return {
    estimate: String(body.estimate ?? ''),
    kind: String(body.kind ?? ''),
    sourceId: Number.isInteger(sourceId) && sourceId > 0 ? sourceId : null,
    offers: padRows(offers),
  }
}

/**
 * Validates the form and runs the article 44 evaluation.
 *
 * The errors are keys rather than sentences, because this page is rendered in
 * three languages and the messages belong in the dictionaries.
 * @throws {Error} with a translation key as its message.
 */
function evaluateReferenceForm(form) {
  const estimateCentimes = parseAmountToCentimes(form.estimate)
  if (estimateCentimes === null || estimateCentimes <= 0) throw new Error('referencePrice.error.estimate')
  if (!MARKET_KIND_VALUES.has(form.kind)) throw new Error('referencePrice.error.kind')

  const offers = form.offers
    .map((offer) => ({ name: offer.name.trim(), amountCentimes: parseAmountToCentimes(offer.amount) }))
    .filter((offer) => offer.amountCentimes !== null)

  if (offers.length === 0) throw new Error('referencePrice.error.offers')

  return computeReferencePrice({ estimateCentimes, kind: form.kind, offers })
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
  typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/panel/today'
