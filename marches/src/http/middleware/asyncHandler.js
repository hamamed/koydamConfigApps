/** Forwards rejected promises from async route handlers to the error middleware. */
export const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
