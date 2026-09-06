import { APP_VERSION } from './config/index.js'
import { serializeRows } from './services/serializers.js'
import { getDb } from './db/index.js'
import { createConsultationRepository } from './repositories/consultationRepository.js'
import { createArticleRepository } from './repositories/articleRepository.js'
import { createDocumentRepository } from './repositories/documentRepository.js'
import { createResultRepository } from './repositories/resultRepository.js'
import { createFavoriteRepository } from './repositories/favoriteRepository.js'
import { createInvoiceRepository } from './repositories/invoiceRepository.js'
import { createUserRepository } from './repositories/userRepository.js'
import { createScrapeJobRepository } from './repositories/scrapeJobRepository.js'
import { createSettingsRepository } from './repositories/settingsRepository.js'
import { createAnalyticsRepository } from './repositories/analyticsRepository.js'
import { createSavedSearchRepository } from './repositories/savedSearchRepository.js'
import { createNotificationRepository } from './repositories/notificationRepository.js'
import { createPasswordResetRepository } from './repositories/passwordResetRepository.js'
import { createTranslationRepository } from './repositories/translationRepository.js'
import { createScraperRunner } from './scraper/runner.js'
import { createHealthService } from './scraper/health.js'
import { createConsultationService } from './services/consultationService.js'
import { createFavoriteService } from './services/favoriteService.js'
import { createInvoiceService } from './services/invoiceService.js'
import { createAuthService } from './services/authService.js'
import { createAdminService } from './services/adminService.js'
import { createSettingsService } from './settings/service.js'
import { createUserService } from './services/userService.js'
import { createAnalyticsService } from './services/analyticsService.js'
import { createAlertService } from './notifications/alertService.js'
import { createSavedSearchService } from './services/savedSearchService.js'
import { createPasswordResetService } from './services/passwordResetService.js'
import { createTranslationService } from './services/translationService.js'
import { createTranslator } from './translation/translator.js'
import { createMailer } from './notifications/mailer.js'
import { createSystemInspector } from './system/inspector.js'
import { createPublicService } from './services/publicService.js'
import { createAccessRequestRepository } from './repositories/accessRequestRepository.js'
import { createAccessRequestService } from './services/accessRequestService.js'
import { createCompanyRecordRepository } from './repositories/companyRecordRepository.js'
import { createExclusionRepository } from './repositories/exclusionRepository.js'
import { createCompanyRecordService } from './services/companyRecordService.js'
import { createCompanyLookup } from './enrichment/openCorporates.js'

/**
 * Composition root. Every dependency is injected explicitly so services and
 * routes can be exercised in tests against an in-memory database.
 * @param {object} [db] database driver.
 * @param {{http?: object}} [overrides] e.g. a stubbed HTTP client for tests.
 */
export function createContainer(db = getDb(), options = {}) {
  const { http, mailer: injectedMailer, translator } = options
  const repositories = {
    consultations: createConsultationRepository(db),
    articles: createArticleRepository(db),
    documents: createDocumentRepository(db),
    results: createResultRepository(db),
    favorites: createFavoriteRepository(db),
    invoices: createInvoiceRepository(db),
    users: createUserRepository(db),
    jobs: createScrapeJobRepository(db),
    settings: createSettingsRepository(db),
    analytics: createAnalyticsRepository(db),
    savedSearches: createSavedSearchRepository(db),
    notifications: createNotificationRepository(db),
    passwordResets: createPasswordResetRepository(db),
    translations: createTranslationRepository(db),
    accessRequests: createAccessRequestRepository(db),
    companyRecords: createCompanyRecordRepository(db),
    exclusions: createExclusionRepository(db),
  }

  const settings = createSettingsService(repositories)
  // Reads the key per request, so one saved in the panel works on the next
  // translation rather than on the next restart.
  const translationClient =
    translator ?? createTranslator({ resolve: async () => ({ apiKey: await settings.get('translation.googleApiKey') }) })
  // Same reason: an SMTP server entered in the panel sends the next alert.
  const mailer =
    injectedMailer ??
    createMailer({
      resolve: async () => ({
        host: await settings.get('mail.host'),
        port: await settings.get('mail.port'),
        secure: await settings.get('mail.secure'),
        user: await settings.get('mail.user'),
        password: await settings.get('mail.password'),
        from: await settings.get('mail.from'),
      }),
    })
  // Read per request, like the translation key: a token entered in the panel
  // works on the next lookup rather than the next restart.
  const companyLookup =
    options.companyLookup ??
    createCompanyLookup({ resolve: async () => ({ apiToken: await settings.get('registry.openCorporatesToken') }) })
  const runner = createScraperRunner({ db, ...repositories, settings, ...(http ? { http } : {}) })

  const auth = createAuthService(repositories)
  const baseUrl = process.env.PUBLIC_URL || 'https://bdc.civictrust.ma'
  const services = {
    consultations: createConsultationService({ ...repositories, matcher: runner.matcher }),
    favorites: createFavoriteService(repositories),
    invoices: createInvoiceService({ ...repositories, settings }),
    auth,
    users: createUserService({ ...repositories, auth }),
    settings,
    analytics: createAnalyticsService(repositories),
    savedSearches: createSavedSearchService(repositories),
    alerts: createAlertService({
      ...repositories,
      mailer,
      baseUrl,
    }),
    passwordReset: createPasswordResetService({ ...repositories, auth, mailer, baseUrl }),
    translation: createTranslationService({ ...repositories, translator: translationClient }),
    health: createHealthService({ ...repositories, db }),
    admin: createAdminService({ ...repositories, runner, settings, health: createHealthService({ ...repositories, db }) }),
    mailer,
    public: createPublicService(repositories),
    exclusions: {
      list: async (limit) => serializeRows(await repositories.exclusions.listAll(limit)),
      /** Filtered, each row flagged with whether the ban bites today. */
      search: async (filters, today = new Date().toISOString().slice(0, 10)) =>
        serializeRows(await repositories.exclusions.search(filters, today)).map((row) => ({
          ...row,
          active: (!row.date_debut || row.date_debut <= today) && (!row.date_fin || row.date_fin >= today),
        })),
      entities: () => repositories.exclusions.listEntities(),
      countAll: () => repositories.exclusions.countAll(),
      countActive: () => repositories.exclusions.countActive(),
    },
    accessRequests: createAccessRequestService({ ...repositories, auth, mailer, settings }),
    companyRecords: createCompanyRecordService({ ...repositories, companyLookup }),
  }
  services.system = createSystemInspector({
    settings,
    mailer,
    translation: services.translation,
    appVersion: APP_VERSION,
  })

  return { db, repositories, services, runner, settings }
}
