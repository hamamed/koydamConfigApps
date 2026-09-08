import { APP_VERSION } from './config/index.js'
import { serializeRows } from './services/serializers.js'
import { getDb } from './db/index.js'
import { createConsultationRepository } from './repositories/consultationRepository.js'
import { createDocumentRepository } from './repositories/documentRepository.js'
import { createFavoriteRepository } from './repositories/favoriteRepository.js'
import { createInvoiceRepository } from './repositories/invoiceRepository.js'
import { createInvoiceBrandingRepository } from './repositories/invoiceBrandingRepository.js'
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
import { createInvoiceBrandingService } from './services/invoiceBrandingService.js'
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
import { createCompanyRecordRepository } from './repositories/companyRecordRepository.js'
import { createAccessRequestRepository } from './repositories/accessRequestRepository.js'
import { createCompanyRecordService } from './services/companyRecordService.js'
import { createAccessRequestService } from './services/accessRequestService.js'
import { createBtpRepository } from './repositories/btpRepository.js'
import { createTodayService } from './services/todayService.js'
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
    documents: createDocumentRepository(db),
    favorites: createFavoriteRepository(db),
    invoices: createInvoiceRepository(db),
    invoiceBranding: createInvoiceBrandingRepository(db),
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
    btp: createBtpRepository(db),
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
  const baseUrl = process.env.PUBLIC_URL || 'https://marches.civictrust.ma'
  // Built before the services object because the invoice service prints
  // with it, and the panel edits it.
  const invoiceBranding = createInvoiceBrandingService({ ...repositories, settings })

  const services = {
    invoiceBranding,
    consultations: createConsultationService({ ...repositories }),
    favorites: createFavoriteService(repositories),
    invoices: createInvoiceService({ ...repositories, settings, branding: invoiceBranding }),
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
    companyRecords: createCompanyRecordService({ ...repositories, companyLookup }),
    accessRequests: createAccessRequestService({ ...repositories, auth, mailer, settings }),
  }
  services.today = createTodayService({
    consultations: services.consultations,
    favorites: services.favorites,
    savedSearches: services.savedSearches,
    users: repositories.users,
  })
  services.system = createSystemInspector({
    settings,
    jobs: repositories.jobs,
    results: repositories.results,
    mailer,
    translation: services.translation,
    appVersion: APP_VERSION,
  })

  return { db, repositories, services, runner, settings }
}
