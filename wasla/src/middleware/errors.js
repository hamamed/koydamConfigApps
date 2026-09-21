import { config } from '../config.js';

/** 404 handler. Content negotiation keeps the API returning JSON and the panel returning HTML. */
export function notFound(req, res) {
  if (req.path.startsWith('/api/')) {
    // `error` is the API's shape; `status` and `message` are kept for anything already reading them.
    return res.status(404).json({ error: 'Not found', status: 'error', message: 'Not found' });
  }
  return res.status(404).render('error', {
    title: 'غير موجودة',
    status: 404,
    message: 'هذه الصفحة غير موجودة.',
    detail: null,
  });
}

/* eslint-disable no-unused-vars */
export function errorHandler(error, req, res, next) {
  const status = error.status || 500;

  if (status >= 500) console.error(error);

  if (req.path.startsWith('/api/')) {
    const message = status >= 500 ? 'Something went wrong' : error.message;
    return res.status(status).json({ error: message, status: 'error', message });
  }

  return res.status(status).render('error', {
    title: status >= 500 ? 'خطأ في الخادم' : 'حدث خطأ',
    status,
    message: status >= 500 ? 'حدث خطأ من جهتنا.' : error.message,
    // Stack traces are useful in development and an information leak in production.
    detail: config.isProduction ? null : error.stack,
  });
}
