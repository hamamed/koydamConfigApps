import { AppError } from '../../utils/errors.js'
import { config } from '../../config/index.js'
import { logger } from '../../utils/logger.js'

const log = logger.child('[http]')

export function notFoundHandler(req, res) {
  res.status(404).json({ success: false, data: null, error: `No route for ${req.method} ${req.path}` })
}

/**
 * Single JSON error boundary.
 *
 * Only `AppError` messages reach the client; anything else is logged in full and
 * reported as a generic 500, so stack traces and SQL never leak.
 */
export function errorHandler(error, req, res, _next) {
  const isOperational = error instanceof AppError
  const statusCode = isOperational ? error.statusCode : 500

  if (!isOperational) {
    log.error('unhandled error', { path: req.path, message: error.message, stack: error.stack })
  } else if (statusCode >= 500) {
    log.error(error.message, { path: req.path, details: error.details })
  }

  res.status(statusCode).json({
    success: false,
    data: null,
    error: isOperational ? error.message : 'Internal server error',
    ...(isOperational && error.details ? { details: error.details } : {}),
    ...(!isOperational && !config.isProduction ? { debug: error.message } : {}),
  })
}
