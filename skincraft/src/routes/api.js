import express from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import {
  listSkins, getSkin, toApiShape, recordDownload,
  reactionFor,
  setReaction, allTags, relatedSkins, logSearch,
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
  // Private, and briefly: `your_reaction` differs per caller, so a shared cache
  // would hand one device another device's opinion back as its own.
  res.set('Cache-Control', 'private, max-age=30');
  return res.json({
    status: 'success',
    data: {
      ...toApiShape(found.row, found.tags),
      your_reaction: reactionFor(found.row.id, clientFingerprint(req)),
    },
  });
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

/**
 * POST /api/v1/skins/:id/reaction — like it, dislike it, or take it back.
 *
 * Body: `{ "value": 1 | -1 | 0 }`. Unauthenticated like everything else here,
 * and identified the same way downloads are: by client fingerprint. That is
 * honest about what it measures — approval from the devices that reached this
 * server, not from verified people — and it is the same guarantee the download
 * counter has always given.
 */
apiRouter.post('/skins/:id/reaction', writeLimiter, (req, res) => {
  const raw = req.body?.value;
  const value = Number(raw);

  if (![1, -1, 0].includes(value)) {
    return res.status(400).json({
      status: 'error',
      message: 'value must be 1 to like, -1 to dislike, or 0 to withdraw.',
    });
  }

  const result = setReaction(req.params.id, clientFingerprint(req), value);

  if (result === null) {
    return res.status(404).json({ status: 'error', message: 'Skin not found' });
  }
  return res.json({ status: 'success', data: { id: req.params.id, ...result } });
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
 * A non-identifying client key.
 *
 * Two sources, in order of preference.
 *
 * `X-Device-Id` is a random UUID the app generates once and keeps in its keychain. It is the
 * only one of the two that is actually stable, which reactions need: a like is a standing
 * opinion, so the key that recorded it has to still be the same key an hour, a week or a
 * network change later, or the same person can like the same skin over and over.
 *
 * The IP-and-user-agent hash is the fallback for callers that send no header — the web panel,
 * curl, anything that isn't the app. It is salted with the date, so yesterday's keys can't be
 * correlated with today's. That rotation is a real privacy property and it stays, but it is
 * also why this cannot be the primary source: it changes at midnight UTC, and it changes again
 * every time a phone moves between Wi-Fi and cellular. Both look identical to a person who
 * simply reopened the app, and both let them vote twice.
 *
 * Neither form stores the raw IP, and the device id is hashed with the session secret before it
 * goes anywhere near the database, so a leaked table cannot be joined back to a device.
 */
function clientFingerprint(req) {
  const device = (req.get('x-device-id') || '').trim();

  if (device) {
    return crypto
      .createHash('sha256')
      .update(`device|${config.sessionSecret}|${device.slice(0, 200)}`)
      .digest('hex')
      .slice(0, 32);
  }

  const day = new Date().toISOString().slice(0, 10);
  const ip = req.ip || req.socket.remoteAddress || '';
  const agent = req.get('user-agent') || '';

  return crypto
    .createHash('sha256')
    .update(`${day}|${config.sessionSecret}|${ip}|${agent}`)
    .digest('hex')
    .slice(0, 32);
}
