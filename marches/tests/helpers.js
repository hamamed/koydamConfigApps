import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSqliteDriver } from '../src/db/drivers/sqlite.js'
import { initDatabase } from '../src/db/init.js'
import { setDb } from '../src/db/index.js'
import { createContainer } from '../src/container.js'

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

export const fixture = (name) => fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8')

/** Fresh in-memory database + container for a single test file. */
export async function createTestContainer(overrides = {}) {
  const db = createSqliteDriver({ file: ':memory:' })
  setDb(db)
  await initDatabase(db)
  return createContainer(db, overrides)
}

/**
 * Fake `fetch` that serves fixtures by URL pattern, so the scraper can be tested
 * end to end without touching the network.
 * @param {Array<[RegExp, string]>} routes
 */
export function createFetchStub(routes) {
  const calls = []
  const fetchImpl = async (url) => {
    const target = String(url)
    calls.push(target)
    const match = routes.find(([pattern]) => pattern.test(target))
    if (!match) throw new Error(`No fixture registered for ${target}`)
    return {
      ok: true,
      status: 200,
      url: target,
      headers: { getSetCookie: () => ['PHPSESSID=test; path=/'] },
      text: async () => match[1],
    }
  }
  fetchImpl.calls = calls
  return fetchImpl
}

/** Boots the app on an ephemeral port and returns a fetch helper bound to it. */
export async function startTestServer(app) {
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, () => resolve(listener))
  })
  const base = `http://127.0.0.1:${server.address().port}`

  const request = async (method, pathname, { body, token, raw = false } = {}) => {
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, body: raw ? Buffer.from(await response.arrayBuffer()) : await response.json(), headers: response.headers }
  }

  return { base, request, close: () => new Promise((resolve) => server.close(resolve)) }
}
