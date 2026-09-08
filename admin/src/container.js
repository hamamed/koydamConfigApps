import { createServiceClient } from './services/serviceClient.js'

/**
 * The console holds no state of its own — no database, no accounts, no
 * settings. Everything it shows belongs to a service, so there is one
 * collaborator: the client that talks to them.
 */
export function createContainer(overrides = {}) {
  return { client: overrides.client ?? createServiceClient() }
}
