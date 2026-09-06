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

/**
 * Composition root. Every dependency is injected explicitly so services and
 * routes can be exercised in tests against an in-memory database.
 * @param {object} [db] database driver.
 * @param {{http?: object}} [overrides] e.g. a stubbed HTTP client for tests.
 */
export function createContainer(db = getDb(), { http, mailer = createMailer(), translator = createTranslator() } = {}) {
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
  }

  const settings = createSettingsService(repositories)
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
    translation: createTranslationService({ ...repositories, translator }),
    health: createHealthService({ ...repositories, db }),
    admin: createAdminService({ ...repositories, runner, settings, health: createHealthService({ ...repositories, db }) }),
  }

  return { db, repositories, services, runner, settings }
}
