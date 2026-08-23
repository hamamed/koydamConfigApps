import express from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import {
  listSkins, getSkin, toApiShape, recordDownload, allTags, relatedSkins, logSearch,
} from '../services/skins.js';
import {
  normaliseCategory, normaliseSort, clampInt, normaliseReason, cleanText, REPORT_REASONS,
} from '../utils/validate.js';
import { createReport } from '../services/reports.js';
import { normaliseColor, colorChips } from '../utils/color.js';

export const apiRouter = express.Router();

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many requests' },
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many requests' },
});

apiRouter.use(readLimiter);

/**
 * GET /api/v1/skins
 *
 * Query: category, page, limit, q, sort, featured
 * The response envelope is exactly what the iOS client decodes — `status`, `data`, `meta`.
 */
apiRouter.get('/skins', (req, res) => {
  const page = clampInt(req.query.page, { min: 1, max: 10_000, fallback: 1 });
  const limit = clampInt(req.query.limit, {
    min: 1,
    max: config.maxPageSize,
    fallback: config.defaultPageSize,
  });

  const search = String(req.query.q || req.query.search || '').trim().slice(0, 80);

  const category = normaliseCategory(req.query.category);

  const result = listSkins({
    category,
    search: search || null,
    sort: normaliseSort(req.query.sort),
    featuredOnly: req.query.featured === 'true' || req.query.featured === '1',
    color: normaliseColor(req.query.color),
    published: true,
    page,
    limit,
  });

  // Log the intent, not the paging. Zero-result terms become the catalogue's to-do list.
  if (search && page === 1) {
    logSearch({ term: search, category, results: result.total });
  }

  const data = result.rows.map((row) => toApiShape(row, result.tags.get(row.id)));

  // Short public cache: the catalogue changes when an admin publishes something, not per
  // request. `stale-while-revalidate` lets a CDN keep serving while it refreshes behind.
  res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');

  res.json({
    status: 'success',
    data,
    meta: {
      page: result.page,
      limit: result.limit,
      total: result.total,
      has_more: result.hasMore,
    },
  });
});

/** GET /api/v1/skins/:id — single skin, same item shape as the list. */
apiRouter.get('/skins/:id', (req, res) => {
  const found = getSkin(req.params.id, { published: true });
  if (!found) {
    return res.status(404).json({ status: 'error', message: 'Skin not found' });
  }
  res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  return res.json({ status: 'success', data: toApiShape(found.row, found.tags) });
});

/**
 * POST /api/v1/skins/:id/download
 *
 * Fire-and-forget from the client's perspective. Repeat calls from the same client on the same
 * day are collapsed, so the counter measures reach rather than button taps.
 */
apiRouter.post('/skins/:id/download', writeLimiter, (req, res) => {
  const clientKey = clientFingerprint(req);
  const downloads = recordDownload(req.params.id, clientKey);

  if (downloads === null) {
    return res.status(404).json({ status: 'error', message: 'Skin not found' });
  }
  return res.json({ status: 'success', data: { id: req.params.id, downloads } });
});

/** GET /api/v1/skins/:id/related — the "more like this" row on the detail screen. */
apiRouter.get('/skins/:id/related', (req, res) => {
  const limit = clampInt(req.query.limit, { min: 1, max: 20, fallback: 8 });
  const result = relatedSkins(req.params.id, limit);

  res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
  res.json({
    status: 'success',
    data: result.rows.map((row) => toApiShape(row, result.tags.get(row.id))),
  });
});

/**
 * POST /api/v1/skins/:id/report
 *
 * The only channel for problems the server cannot see. A template that's misaligned in Roblox
 * renders perfectly here — the only signal that it's broken is somebody saying so.
 */
apiRouter.post('/skins/:id/report', writeLimiter, (req, res) => {
  const reason = normaliseReason(req.body?.reason);
  if (!reason) {
    return res.status(400).json({
      status: 'error',
      message: 'Pick a reason',
      data: { reasons: REPORT_REASONS },
    });
  }

  const result = createReport({
    skinId: req.params.id,
    reason,
    note: cleanText(req.body?.note, 400),
    clientKey: clientFingerprint(req),
  });

  if (result === null) {
    return res.status(404).json({ status: 'error', message: 'Skin not found' });
  }

  // `false` means "already reported today". That isn't a failure the reporter should see — from
  // their side the report landed, and telling them otherwise invites a second one.
  return res.json({ status: 'success', data: { recorded: true } });
});

/** GET /api/v1/report-reasons — keeps the app's reason list in step with the server's. */
apiRouter.get('/report-reasons', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    status: 'success',
    data: Object.entries(REPORT_REASONS).map(([id, label]) => ({ id, label })),
  });
});

/** GET /api/v1/colors — the colour chips shown in Explore, with their swatch values. */
apiRouter.get('/colors', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ status: 'success', data: colorChips() });
});

/** GET /api/v1/tags — powers tag suggestions in the client. */
apiRouter.get('/tags', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    status: 'success',
    data: allTags().filter((tag) => tag.uses > 0).slice(0, 60),
  });
});

/** GET /api/v1/health — for uptime checks and load balancers. */
apiRouter.get('/health', (req, res) => {
  res.json({ status: 'success', data: { ok: true, time: new Date().toISOString() } });
});

/**
 * A coarse, non-identifying client key: a daily-salted hash of IP and user agent.
 *
 * The salt rotates with the date, so yesterday's keys can't be correlated with today's, and the
 * raw IP is never stored — we only need "is this the same client, today", not "who is this".
 */
function clientFingerprint(req) {
  const day = new Date().toISOString().slice(0, 10);
  const ip = req.ip || req.socket.remoteAddress || '';
  const agent = req.get('user-agent') || '';

  return crypto
    .createHash('sha256')
    .update(`${day}|${config.sessionSecret}|${ip}|${agent}`)
    .digest('hex')
    .slice(0, 32);
}
