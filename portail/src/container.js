import { getDb } from './db/index.js'
import { createUserRepository } from './repositories/userRepository.js'
import { createSignInRepository } from './repositories/signInRepository.js'
import { createAuthService } from './services/authService.js'

/**
 * Wires the portal. Small on purpose: it holds accounts and nothing else, so
 * there is one repository pair and one service.
 */
export function createContainer(db = getDb()) {
  const users = createUserRepository(db)
  const signIns = createSignInRepository(db)

  return {
    db,
    repositories: { users, signIns },
    services: {
      auth: createAuthService({ users, signIns }),
      signIns,
      users,
    },
  }
}
