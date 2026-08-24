import { config } from '../config.js';
import { log } from '../log.js';

/**
 * An upstream failure carrying the status we intend to pass through to the app.
 *
 * The Flutter client's `ApiException._fromStatus` already maps 400/403/404/429/
 * 503 to specific user-facing copy, so preserving Supercell's status code is
 * what makes those messages correct.
 */
export class UpstreamError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Normalises a player/club tag for use in a URL path.
 *
 * The `#` MUST be percent-encoded. Left raw, everything after it is treated as
 * a URL fragment and never reaches the server — the request silently becomes a
 * lookup for an empty tag.
 */
export function encodeTag(raw) {
  const upper = String(raw ?? '').trim().toUpperCase();
  const bare = upper.startsWith('#') ? upper.slice(1) : upper;
  return `%23${encodeURIComponent(bare)}`;
}

/** Supercell's tag alphabet — deliberately omits I, O, S, B (vs 1, 0, 5, 8). */
const TAG_RE = /^[0289PYLQGRJCUVXWKFMTZ]{3,14}$/;

export function isValidTag(raw) {
  const upper = String(raw ?? '').trim().toUpperCase();
  return TAG_RE.test(upper.startsWith('#') ? upper.slice(1) : upper);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GETs a path from the official API.
 *
 * Retries only on transient failures — network errors, 429 and 5xx. A 404 or
 * 403 is a settled answer and retrying it just wastes rate limit.
 */
export async function supercellGet(path, { retries = config.supercell.retries } = {}) {
  const url = `${config.supercell.baseUrl}${path}`;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    // A fresh timeout per attempt, or a slow first try would eat the budget for
    // the retries too.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.supercell.timeoutMs);

    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${config.supercell.token}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (res.ok) return await res.json();

      const body = await res.text().catch(() => '');
      const retryable = res.status === 429 || res.status >= 500;

      if (!retryable || attempt === retries) {
        // 403 almost always means the token's IP allowlist doesn't include this
        // box — by far the most common setup mistake, so it gets a loud hint.
        if (res.status === 403) {
          log.error('Supercell rejected the token (403)', {
            hint: 'Check the token\'s allowed IP matches this server\'s public IPv4',
            path,
          });
        }
        throw new UpstreamError(
          res.status,
          `Supercell ${res.status} for ${path}`,
          body.slice(0, 400),
        );
      }

      // Honour Retry-After when the API sends it, else exponential backoff.
      const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
      const delay = Number.isNaN(retryAfter)
        ? 300 * 2 ** attempt
        : retryAfter * 1000;

      log.warn('Retrying upstream request', {
        path,
        status: res.status,
        attempt: attempt + 1,
        delay,
      });
      await sleep(delay);
      lastError = new UpstreamError(res.status, `Supercell ${res.status}`, body);
    } catch (err) {
      clearTimeout(timer);

      // A settled status — don't retry, don't swallow.
      if (err instanceof UpstreamError && err.status < 500 && err.status !== 429) {
        throw err;
      }

      lastError = err;
      if (attempt === retries) break;

      const delay = 300 * 2 ** attempt;
      log.warn('Upstream request failed, retrying', {
        path,
        attempt: attempt + 1,
        error: err.message,
        delay,
      });
      await sleep(delay);
    }
  }

  if (lastError instanceof UpstreamError) throw lastError;

  // AbortError surfaces as a timeout; 504 is the honest status for it.
  const isTimeout = lastError?.name === 'AbortError';
  throw new UpstreamError(
    isTimeout ? 504 : 502,
    isTimeout ? `Upstream timeout for ${path}` : `Upstream unreachable for ${path}`,
    lastError?.message,
  );
}

// ── Endpoint helpers ────────────────────────────────────────────────────────

export const supercell = {
  player: (tag) => supercellGet(`/players/${encodeTag(tag)}`),
  battleLog: (tag) => supercellGet(`/players/${encodeTag(tag)}/battlelog`),
  club: (tag) => supercellGet(`/clubs/${encodeTag(tag)}`),
  clubMembers: (tag) => supercellGet(`/clubs/${encodeTag(tag)}/members`),
  brawlers: () => supercellGet('/brawlers'),
  events: () => supercellGet('/events/rotation'),

  /**
   * Top players for a region. `global` is a valid country code here; anything
   * else must be a two-letter ISO code.
   *
   * Note Brawl Stars uses `/rankings/{country}/…` directly — unlike Clash of
   * Clans, there is no `/locations` endpoint to resolve numeric ids from, which
   * is why the country list is shipped as static data rather than fetched.
   */
  rankingsPlayers: (region = 'global', limit = 200) =>
    supercellGet(`/rankings/${region}/players?limit=${limit}`),

  /** Top clubs for a region. Same path shape as [rankingsPlayers]. */
  rankingsClubs: (region = 'global', limit = 200) =>
    supercellGet(`/rankings/${region}/clubs?limit=${limit}`),

  /** Top players on one brawler for a region. */
  rankingsBrawler: (region = 'global', brawlerId, limit = 200) =>
    supercellGet(`/rankings/${region}/brawlers/${brawlerId}?limit=${limit}`),
};
