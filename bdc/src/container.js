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
import { createScraperRunner } from './scraper/runner.js'
import { createConsultationService } from './services/consultationService.js'
import { createFavoriteService } from './services/favoriteService.js'
import { createInvoiceService } from './services/invoiceService.js'
import { createAuthService } from './services/authService.js'
import { createAdminService } from './services/adminService.js'
import { createSettingsService } from './settings/service.js'
import { createUserService } from './services/userService.js'

/**
 * Composition root. Every dependency is injected explicitly so services and
 * routes can be exercised in tests against an in-memory database.
 * @param {object} [db] database driver.
 * @param {{http?: object}} [overrides] e.g. a stubbed HTTP client for tests.
 */
export function createContainer(db = getDb(), { http } = {}) {
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
  }

  const settings = createSettingsService(repositories)
  const runner = createScraperRunner({ db, ...repositories, settings, ...(http ? { http } : {}) })

  const auth = createAuthService(repositories)
  const services = {
    consultations: createConsultationService({ ...repositories, matcher: runner.matcher }),
    favorites: createFavoriteService(repositories),
    invoices: createInvoiceService({ ...repositories, settings }),
    auth,
    users: createUserService({ ...repositories, auth }),
    settings,
    admin: createAdminService({ ...repositories, runner, settings }),
  }

  return { db, repositories, services, runner, settings }
}
