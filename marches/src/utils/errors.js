/** Base class for errors that are safe to surface to API clients. */
export class AppError extends Error {
  constructor(message, statusCode = 500, details = undefined) {
    super(message)
    this.name = new.target.name
    this.statusCode = statusCode
    this.details = details
    this.isOperational = true
  }
}

export class ValidationError extends AppError {
  constructor(message, details) {
    super(message, 400, details)
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401)
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Insufficient permissions') {
    super(message, 403)
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404)
  }
}

export class ConflictError extends AppError {
  constructor(message) {
    super(message, 409)
  }
}

export class ScraperError extends AppError {
  constructor(message, details) {
    super(message, 502, details)
  }
}
