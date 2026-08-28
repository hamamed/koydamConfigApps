import express from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import {
  listItems, getItem, toApiShape, recordDownload, reactionFor, setReaction,
  allTags, relatedItems, logSearch, kindSummary, knownVersions, categoryCounts,
} from '../services/items.js';
import { createReport } from '../services/reports.js';
import {
  KINDS, KIND_LABELS, CATEGORIES, CATEGORY_LABELS, EDITIONS, EDITION_LABELS,
  INSTALL_HINTS, REPORT_REASONS,
  normaliseKind, normaliseCategory, normaliseEdition, normaliseSort, normaliseVersion,
  clampInt, cleanText, normaliseReason,
} from '../utils/validate.js';
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
 * GET /api/v1/items
 *
 * Query: kind, category, edition, version, q, sort, featured, color, page, limit
 * The response envelope is exactly what the iOS client decodes — `status`, `data`, `meta`.
 */
apiRouter.get('/items', (req, res) => {
  const page = clampInt(req.query.page, { min: 1, max: 10_000, fallback: 1 });
  const limit = clampInt(req.query.limit, {
    min: 1,
    max: config.maxPageSize,
    fallback: config.defaultPageSize,
  });

  const search = String(req.query.q || req.query.search || '').trim().slice(0, 80);
  const kind = normaliseKind(req.query.kind);

  // A category only means something inside a kind, so one arriving without a kind is dropped
  // rather than matched across all five. 'survival' exists under both addons and worlds and
  // means a different thing in each; honouring it globally would mix them into one list.
  const category = kind ? normaliseCategory(kind, req.query.category) : null;

  const result = listItems({
    kind,
    category,
    edition: normaliseEdition(req.query.edition),
    version: normaliseVersion(req.query.version),
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
    logSearch({ term: search, kind, results: result.total });
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

/** GET /api/v1/items/:id — one item, same shape as an entry in the list. */
apiRouter.get('/items/:id', (req, res) => {
  const found = getItem(req.params.id, { published: true });
  if (!found) {
    return res.status(404).json({ status: 'error', message: 'Not found' });
  }
  // Private, and briefly: `your_reaction` differs per caller, so a shared cache would hand one
  // device another device's opinion back as its own.
  res.set('Cache-Control', 'private, max-age=30');
  return res.json({
    status: 'success',
    data: {
      ...toApiShape(found.row, found.tags),
      your_reaction: reactionFor(found.row.id, clientFingerprint(req)),
    },
  });
});

/** GET /api/v1/items/:id/related — the "more like this" row on the detail screen. */
apiRouter.get('/items/:id/related', (req, res) => {
  const limit = clampInt(req.query.limit, { min: 1, max: 20, fallback: 8 });
  const result = relatedItems(req.params.id, limit);

  res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
  res.json({
    status: 'success',
    data: result.rows.map((row) => toApiShape(row, result.tags.get(row.id))),
  });
});

/**
 * POST /api/v1/items/:id/download
 *
 * Records interest without serving anything. The file itself comes from `/d/:id`, which counts
 * the download on its own — so this exists for the two cases that route cannot cover: a seed,
 * which is copied rather than downloaded, and a share, where the item leaves the app without
 * anyone fetching bytes from us.
 *
 * Repeat calls from the same client on the same day are collapsed, so the counter measures
 * reach rather than button taps, and calling both this and `/d/:id` cannot double-count.
 */
apiRouter.post('/items/:id/download', writeLimiter, (req, res) => {
  const downloads = recordDownload(req.params.id, clientFingerprint(req));

  if (downloads === null) {
    return res.status(404).json({ status: 'error', message: 'Not found' });
  }
  return res.json({ status: 'success', data: { id: req.params.id, downloads } });
});

/**
 * POST /api/v1/items/:id/reaction — like it, dislike it, or take it back.
 *
 * Body: `{ "value": 1 | -1 | 0 }`. Unauthenticated like everything else here, and identified
 * the same way downloads are: by client fingerprint. That is honest about what it measures —
 * approval from the devices that reached this server, not from verified people — and it is the
 * same guarantee the download counter has always given.
 */
apiRouter.post('/items/:id/reaction', writeLimiter, (req, res) => {
  const value = Number(req.body?.value);

  if (![1, -1, 0].includes(value)) {
    return res.status(400).json({
      status: 'error',
      message: 'value must be 1 to like, -1 to dislike, or 0 to withdraw.',
    });
  }

  const result = setReaction(req.params.id, clientFingerprint(req), value);

  if (result === null) {
    return res.status(404).json({ status: 'error', message: 'Not found' });
  }
  return res.json({ status: 'success', data: { id: req.params.id, ...result } });
});

/**
 * POST /api/v1/items/:id/report
 *
 * The only channel for problems the server cannot see. An addon whose archive is well-formed
 * and whose manifest parses can still crash on import; the only signal is somebody saying so.
 */
apiRouter.post('/items/:id/report', writeLimiter, (req, res) => {
  const reason = normaliseReason(req.body?.reason);
  if (!reason) {
    return res.status(400).json({
      status: 'error',
      message: 'Pick a reason',
      data: { reasons: REPORT_REASONS },
    });
  }

  const result = createReport({
    itemId: req.params.id,
    reason,
    note: cleanText(req.body?.note, 400),
    clientKey: clientFingerprint(req),
  });

  if (result === null) {
    return res.status(404).json({ status: 'error', message: 'Not found' });
  }

  // `false` means "already reported today". That isn't a failure the reporter should see —
  // from their side the report landed, and telling them otherwise invites a second one.
  return res.json({ status: 'success', data: { recorded: true } });
});

/**
 * GET /api/v1/kinds — the app's tab bar, with counts.
 *
 * Sent rather than compiled into the client so that a kind with nothing behind it can be
 * hidden today, and a sixth kind can appear without an App Store release.
 */
apiRouter.get('/kinds', (req, res) => {
  const counts = kindSummary();

  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    status: 'success',
    data: KINDS.map((kind) => ({
      kind,
      label: KIND_LABELS[kind],
      items: counts.get(kind)?.items ?? 0,
      downloads: counts.get(kind)?.downloads ?? 0,
      categories: CATEGORIES[kind].map((category) => ({
        category,
        label: CATEGORY_LABELS[category] || category,
      })),
    })),
  });
});

/** GET /api/v1/categories?kind=addons — the filter row, with only the categories in use. */
apiRouter.get('/categories', (req, res) => {
  const kind = normaliseKind(req.query.kind);
  if (!kind) {
    return res.status(400).json({
      status: 'error',
      message: `kind must be one of: ${KINDS.join(', ')}`,
    });
  }

  const counts = new Map(categoryCounts(kind).map((row) => [row.category, row.items]));

  res.set('Cache-Control', 'public, max-age=300');
  return res.json({
    status: 'success',
    data: CATEGORIES[kind].map((category) => ({
      category,
      label: CATEGORY_LABELS[category] || category,
      items: counts.get(category) ?? 0,
    })),
  });
});

/** GET /api/v1/versions — Minecraft versions actually present, for the version filter. */
apiRouter.get('/versions', (req, res) => {
  res.set('Cache-Control', 'public, max-age=600');
  res.json({ status: 'success', data: knownVersions(normaliseKind(req.query.kind)) });
});

/** GET /api/v1/editions — Bedrock, Java, or both, with the labels the app should show. */
apiRouter.get('/editions', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    status: 'success',
    data: EDITIONS.map((edition) => ({ edition, label: EDITION_LABELS[edition] })),
  });
});

/**
 * GET /api/v1/install-hints — the instructions shown under a download button.
 *
 * Each item already carries the hint for its own format. This is the whole table, for a help
 * screen — and so that correcting a wording reaches every installed copy of the app at once
 * rather than at the next release.
 */
apiRouter.get('/install-hints', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    status: 'success',
    data: Object.entries(INSTALL_HINTS).map(([method, hint]) => ({ method, hint })),
  });
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
 * The salt rotates with the date, so yesterday's keys can't be correlated with today's, and
 * the raw IP is never stored — we only need "is this the same client, today", not "who is
 * this".
 */
export function clientFingerprint(req) {
  const day = new Date().toISOString().slice(0, 10);
  const ip = req.ip || req.socket.remoteAddress || '';
  const agent = req.get('user-agent') || '';

  return crypto
    .createHash('sha256')
    .update(`${day}|${config.sessionSecret}|${ip}|${agent}`)
    .digest('hex')
    .slice(0, 32);
}
