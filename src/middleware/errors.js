import { config } from '../config.js';

/** 404 handler. Content negotiation keeps the API returning JSON and the panel returning HTML. */
export function notFound(req, res) {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ status: 'error', message: 'Not found' });
  }
  return res.status(404).render('error', {
    title: 'Not found',
    status: 404,
    message: "That page doesn't exist.",
    detail: null,
  });
}

/* eslint-disable no-unused-vars */
export function errorHandler(error, req, res, next) {
  const status = error.status || 500;

  if (status >= 500) console.error(error);

  if (req.path.startsWith('/api/')) {
    return res.status(status).json({
      status: 'error',
      message: status >= 500 ? 'Something went wrong' : error.message,
    });
  }

  return res.status(status).render('error', {
    title: status >= 500 ? 'Server error' : 'Something went wrong',
    status,
    message: status >= 500 ? 'Something went wrong on our end.' : error.message,
    // Stack traces are useful in development and an information leak in production.
    detail: config.isProduction ? null : error.stack,
  });
}
