import { config } from '../config.js';
import { log } from '../log.js';
import { UpstreamError } from '../supercell/client.js';

/** Thrown by routes for client-side mistakes (bad tag, unknown region). */
export class BadRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadRequestError';
    this.status = 400;
  }
}

/** Wraps an async route so a rejected promise reaches the error handler. */
export const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Optional bearer-token gate.
 *
 * Guards against someone else pointing their app at your VPS and burning your
 * Supercell rate limit. Off when PUBLIC_API_KEY is unset.
 */
export function requireApiKey(req, res, next) {
  if (!config.apiKey) return next();
  if (req.path === '/health') return next();

  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (token !== config.apiKey) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Missing or invalid API key.',
    });
  }
  return next();
}

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: 'route_not_found',
    message: `No route for ${req.method} ${req.path}`,
  });
}

/**
 * Terminal error handler.
 *
 * Passes upstream status codes straight through, because the Flutter client's
 * `ApiException._fromStatus` maps 400/403/404/429/503 to specific user-facing
 * copy. Collapsing everything to 500 would turn "No player found with that tag"
 * into "Server error".
 */
// eslint-disable-next-line no-unused-vars -- Express identifies handlers by arity
export function errorHandler(err, req, res, next) {
  if (err instanceof BadRequestError) {
    return res.status(400).json({ error: 'bad_request', message: err.message });
  }

  if (err instanceof UpstreamError) {
    const status = err.status;

    if (status >= 500) {
      log.error('Upstream failure', { path: req.path, status, message: err.message });
    } else {
      log.debug('Upstream client error', { path: req.path, status });
    }

    return res.status(status).json({
      error: upstreamErrorCode(status),
      message: upstreamMessage(status),
      ...(config.env !== 'production' ? { upstream: err.body } : {}),
    });
  }

  log.error('Unhandled error', {
    path: req.path,
    message: err.message,
    stack: config.env === 'production' ? undefined : err.stack,
  });

  return res.status(500).json({
    error: 'internal_error',
    message: 'Something went wrong.',
  });
}

function upstreamErrorCode(status) {
  switch (status) {
    case 400:
      return 'invalid_tag';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 429:
      return 'rate_limited';
    case 503:
      return 'maintenance';
    case 504:
      return 'upstream_timeout';
    default:
      return 'upstream_error';
  }
}

function upstreamMessage(status) {
  switch (status) {
    case 400:
      return 'That tag is not valid.';
    case 403:
      // Surfaced honestly — this is a server misconfiguration, not user error.
      return 'Server is not authorised to read the Brawl Stars API.';
    case 404:
      return 'Not found.';
    case 429:
      return 'Too many requests. Try again shortly.';
    case 503:
      return 'Brawl Stars is in maintenance.';
    case 504:
      return 'The Brawl Stars API timed out.';
    default:
      return 'Upstream error.';
  }
}
