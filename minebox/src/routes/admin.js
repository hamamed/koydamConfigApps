import express from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { requireAuth, verifyCredentials, csrfToken, csrfProtect } from '../middleware/auth.js';
import { uploadItemFiles, handleUploadErrors } from '../middleware/upload.js';
import {
  listItems, getItem, toAdminShape, createItem, updateItem,
  toggleFeatured, togglePublished, deleteItem, allTags, logAudit, knownVersions,
} from '../services/items.js';
import { ingest } from '../services/ingest.js';
import { removeFile } from '../services/files.js';
import { summarise } from '../services/packs.js';
import * as stats from '../services/stats.js';
import * as reports from '../services/reports.js';
import {
  KINDS, KIND_LABELS, CATEGORIES, CATEGORY_LABELS, EDITIONS, EDITION_LABELS,
  ACCEPTED_EXTENSIONS, REPORT_REASONS, INSTALL_HINTS,
  normaliseKind, normaliseCategory, normaliseEdition, normaliseVersion, normaliseSeed,
  cleanText, clampInt, hasFile,
} from '../utils/validate.js';
import { generateItemId, parseTags } from '../utils/ids.js';

export const adminRouter = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  message: 'Too many sign-in attempts. Try again in a few minutes.',
});

adminRouter.use(csrfToken);

// Verify the token for every mutating request except the multipart ones, which can only be
// checked once multer has parsed the body — those routes chain `csrfProtect` themselves.
adminRouter.use((req, res, next) => {
  if (req.is('multipart/*')) return next();
  return csrfProtect(req, res, next);
});

// Values every admin template needs.
adminRouter.use((req, res, next) => {
  res.locals.kinds = KINDS;
  res.locals.kindLabels = KIND_LABELS;
  res.locals.categories = CATEGORIES;
  res.locals.categoryLabels = CATEGORY_LABELS;
  res.locals.editions = EDITIONS;
  res.locals.editionLabels = EDITION_LABELS;
  res.locals.reportReasons = REPORT_REASONS;
  res.locals.currentPath = req.path;
  // Cheap indexed count; the badge is only meaningful if it's on every screen.
  res.locals.openReports = req.user ? reports.openReportCount() : 0;
  next();
});

// MARK: - Authentication

adminRouter.get('/login', (req, res) => {
  if (req.user) return res.redirect('/admin');
  return res.render('login', {
    title: 'Sign in',
    next: typeof req.query.next === 'string' ? req.query.next : '/admin',
    error: null,
  });
});

adminRouter.post('/login', loginLimiter, (req, res) => {
  const user = verifyCredentials(req.body.username, req.body.password);
  const next = typeof req.body.next === 'string' && req.body.next.startsWith('/admin')
    ? req.body.next
    : '/admin';

  if (!user) {
    return res.status(401).render('login', {
      title: 'Sign in',
      next,
      error: 'That username and password combination is not recognised.',
    });
  }

  // Rotate the session id on privilege change — otherwise a session fixed before login stays
  // valid after it.
  return req.session.regenerate((error) => {
    if (error) throw error;
    req.session.userId = user.id;
    logAudit(user.id, 'auth.login', user.username, null);
    return req.session.save(() => res.redirect(next));
  });
});

adminRouter.post('/logout', (req, res) => {
  const userId = req.user?.id;
  if (userId) logAudit(userId, 'auth.logout', req.user.username, null);
  req.session.destroy(() => res.redirect('/admin/login'));
});

adminRouter.use(requireAuth);

// MARK: - Dashboard

adminRouter.get('/', async (req, res, next) => {
  try {
    res.render('dashboard', {
      title: 'Dashboard',
      overview: stats.overview(),
      series: stats.downloadSeries(14),
      searches: stats.searchInsights(),
      breakdown: stats.kindBreakdown(),
      top: stats.topItems(6),
      activity: stats.recentActivity(8),
      // The only await here, and it walks the storage tree — an unreadable or missing
      // directory rejects. Express does not catch a rejected async handler, so unguarded this
      // would not fail the page, it would end the process.
      storage: await stats.storage(),
      publicUrl: config.publicUrl,
    });
  } catch (error) {
    return next(error);
  }
});

// MARK: - Analytics

adminRouter.get('/analytics', (req, res) => {
  const days = [7, 14, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 14;

  res.render('analytics', {
    title: 'Analytics',
    days,
    summary: stats.periodSummary(days),
    downloads: stats.downloadSeries(days),
    uniques: stats.uniqueClientSeries(days),
    kindSeries: stats.kindSeries(days),
    movers: stats.topMovers({ days }),
    tags: stats.tagPerformance({ days }),
    searches: stats.searchInsights({ days, limit: 8 }),
    reasons: reports.reasonBreakdown({ days }),
    flagged: reports.mostReported(5),
  });
});

// MARK: - Reports

adminRouter.get('/reports', (req, res) => {
  const status = ['open', 'resolved', 'dismissed', 'all'].includes(req.query.status)
    ? req.query.status
    : 'open';
  const page = clampInt(req.query.page, { min: 1, max: 10_000, fallback: 1 });

  const result = reports.listReports({ status, page, limit: 25 });

  res.render('reports', {
    title: 'Reports',
    reports: result.rows,
    pagination: { page: result.page, pageCount: result.pageCount, total: result.total },
    filters: { status },
  });
});

adminRouter.post('/reports/:id/status', (req, res, next) => {
  const status = String(req.body.status || '');
  if (!reports.setReportStatus(Number(req.params.id), status, req.user.id)) return next();

  logAudit(req.user.id, `report.${status}`, req.params.id, null);
  req.flash('success', status === 'open' ? 'Report reopened.' : `Report ${status}.`);
  return res.redirect(backTo(req, '/admin/reports'));
});

adminRouter.post('/items/:id/reports/resolve', (req, res) => {
  const count = reports.resolveAllForItem(req.params.id, req.user.id);
  logAudit(req.user.id, 'report.resolveAll', req.params.id, String(count));

  req.flash(
    'success',
    count === 0 ? 'No open reports.' : `Resolved ${count} report${count === 1 ? '' : 's'}.`,
  );
  return res.redirect(backTo(req, `/admin/items/${req.params.id}`));
});

// MARK: - Catalogue

adminRouter.get('/items', (req, res) => {
  const page = clampInt(req.query.page, { min: 1, max: 10_000, fallback: 1 });
  const search = cleanText(req.query.q, 80);
  const kind = normaliseKind(req.query.kind);
  const category = kind ? normaliseCategory(kind, req.query.category) : null;
  const status = ['published', 'draft', 'featured'].includes(req.query.status)
    ? req.query.status
    : 'all';
  const sort = ['trending', 'newest', 'oldest', 'mostDownloaded', 'mostLiked', 'title', 'biggest']
    .includes(req.query.sort) ? req.query.sort : 'newest';

  const result = listItems({
    kind,
    category,
    edition: normaliseEdition(req.query.edition),
    version: normaliseVersion(req.query.version),
    search: search || null,
    sort,
    featuredOnly: status === 'featured',
    published: status === 'published' ? true : status === 'draft' ? false : null,
    page,
    limit: 24,
  });

  res.render('items/index', {
    title: 'Catalogue',
    items: result.rows.map((row) => toAdminShape(row, result.tags.get(row.id))),
    pagination: {
      page: result.page,
      pageCount: result.pageCount,
      total: result.total,
    },
    versions: knownVersions(kind),
    filters: {
      q: search,
      kind: kind || '',
      category: category || '',
      edition: req.query.edition && normaliseEdition(req.query.edition) ? req.query.edition : '',
      version: normaliseVersion(req.query.version) || '',
      status,
      sort,
    },
  });
});

// MARK: - Create

adminRouter.get('/items/new', (req, res) => {
  const kind = normaliseKind(req.query.kind) || 'skin';

  res.render('items/form', {
    title: `Add a ${KIND_LABELS[kind].toLowerCase()}`,
    mode: 'create',
    item: {
      id: generateItemId(),
      kind,
      category: CATEGORIES[kind][0],
      title: '',
      description: '',
      edition: 'bedrock',
      mc_version: '',
      seed_code: '',
      tags: [],
      isFeatured: false,
      isPublished: true,
    },
    accepted: ACCEPTED_EXTENSIONS,
    installHints: INSTALL_HINTS,
    knownTags: allTags().slice(0, 30),
    errors: [],
  });
});

adminRouter.post('/items', uploadItemFiles, handleUploadErrors, csrfProtect, async (req, res, next) => {
  try {
    const form = readForm(req);
    const fileUpload = req.files?.file?.[0];
    const previewUpload = req.files?.preview?.[0];

    const errors = validateForm(form);
    if (hasFile(form.kind) && !fileUpload) {
      errors.push(`A ${KIND_LABELS[form.kind].toLowerCase()} needs a file.`);
    }

    if (errors.length) return renderFormErrors(res, req, { mode: 'create', form, errors });

    const id = generateItemId();

    const stored = await ingest({
      id,
      kind: form.kind,
      title: form.title,
      fileBuffer: fileUpload?.buffer || null,
      originalName: fileUpload?.originalname || null,
      previewBuffer: previewUpload?.buffer || null,
    });

    createItem({ id, ...form, ...stored, createdBy: req.user.id });
    logAudit(req.user.id, 'item.create', id, `${form.kind}: ${form.title}`);

    flashWithWarnings(req, stored.warnings, `“${form.title}” is live in the catalogue.`);
    return res.redirect(`/admin/items/${id}`);
  } catch (error) {
    return next(error);
  }
});

// MARK: - Detail

adminRouter.get('/items/:id', (req, res, next) => {
  const found = getItem(req.params.id);
  if (!found) return next();

  const item = toAdminShape(found.row, found.tags);

  return res.render('items/show', {
    title: item.title,
    item,
    packSummary: summarise(item.pack?.packs),
    installHint: item.install ? INSTALL_HINTS[item.install] : null,
    series: stats.itemSeries(item.id, 14),
    reports: reports.reportsForItem(item.id),
    apiUrl: `${config.publicUrl}/api/v1/items/${item.id}`,
    shareUrl: `${config.publicUrl}/s/${item.id}`,
  });
});

// MARK: - Edit

adminRouter.get('/items/:id/edit', (req, res, next) => {
  const found = getItem(req.params.id);
  if (!found) return next();

  return res.render('items/form', {
    title: `Edit ${found.row.title}`,
    mode: 'edit',
    item: toAdminShape(found.row, found.tags),
    accepted: ACCEPTED_EXTENSIONS,
    installHints: INSTALL_HINTS,
    knownTags: allTags().slice(0, 30),
    errors: [],
  });
});

adminRouter.post('/items/:id', uploadItemFiles, handleUploadErrors, csrfProtect, async (req, res, next) => {
  try {
    const found = getItem(req.params.id);
    if (!found) return next();

    const form = readForm(req);
    const errors = validateForm(form);

    // The kind is fixed once something exists. Changing it would leave a .mcworld filed as a
    // skin with a skin's model recorded against it, and every consumer of the row — the app's
    // install hint, the preview, the size ceiling — reading a shape that no longer matches.
    // Deleting and re-adding is the honest way to do that, and it is two clicks.
    if (form.kind !== found.row.kind) {
      errors.push(
        `This is a ${KIND_LABELS[found.row.kind].toLowerCase()} and cannot become a `
        + `${KIND_LABELS[form.kind].toLowerCase()}. Delete it and add it again.`,
      );
    }

    if (errors.length) {
      return renderFormErrors(res, req, {
        mode: 'edit',
        form: { ...toAdminShape(found.row, found.tags), ...form },
        errors,
      });
    }

    const fileUpload = req.files?.file?.[0];
    const previewUpload = req.files?.preview?.[0];

    const stored = await ingest({
      id: found.row.id,
      kind: found.row.kind,
      title: form.title,
      fileBuffer: fileUpload?.buffer || null,
      originalName: fileUpload?.originalname || null,
      previewBuffer: previewUpload?.buffer || null,
      existing: found.row,
    });

    updateItem(found.row.id, { ...form, ...stored });

    // A replacement with a different extension is stored under a different name, so the old
    // payload would otherwise sit in storage forever, counted against the disk and belonging
    // to nothing.
    if (stored.fileName && found.row.file_name && stored.fileName !== found.row.file_name) {
      await removeFile(found.row.file_name);
    }

    logAudit(req.user.id, 'item.update', found.row.id, form.title);

    flashWithWarnings(req, stored.warnings, 'Changes saved.');
    return res.redirect(`/admin/items/${found.row.id}`);
  } catch (error) {
    return next(error);
  }
});

// MARK: - Quick actions

adminRouter.post('/items/:id/feature', (req, res, next) => {
  const featured = toggleFeatured(req.params.id);
  if (featured === null) return next();

  logAudit(req.user.id, featured ? 'item.feature' : 'item.unfeature', req.params.id, null);

  if (wantsJson(req)) return res.json({ status: 'success', data: { featured } });

  req.flash('success', featured ? 'Added to Featured.' : 'Removed from Featured.');
  return res.redirect(backTo(req, '/admin/items'));
});

adminRouter.post('/items/:id/publish', (req, res, next) => {
  const published = togglePublished(req.params.id);
  if (published === null) return next();

  logAudit(req.user.id, published ? 'item.publish' : 'item.unpublish', req.params.id, null);

  if (wantsJson(req)) return res.json({ status: 'success', data: { published } });

  req.flash('success', published ? 'Published to the catalogue.' : 'Moved to drafts.');
  return res.redirect(backTo(req, '/admin/items'));
});

/**
 * Deletes several at once.
 *
 * Two segments after /items on purpose. A single one would be matched by the `/items/:id`
 * update route defined above it, which would try to save an item called "selected".
 */
adminRouter.post('/items/selected/delete', async (req, res, next) => {
  // A single checkbox arrives as a string, several as an array.
  const ids = [].concat(req.body?.ids ?? [])
    .map((id) => String(id).trim())
    .filter(Boolean)
    // Bounded because it is a list from the page and every entry deletes files.
    .slice(0, 200);

  if (!ids.length) {
    req.flash('error', 'Nothing was selected.');
    return res.redirect(backToList(req));
  }

  try {
    let deleted = 0;
    let missing = 0;

    for (const id of ids) {
      const found = getItem(id);
      // Already gone — someone deleted it in another tab, or the page is stale. Not a failure
      // worth abandoning the rest of the batch for.
      if (!found) { missing += 1; continue; }

      await deleteItem(id);
      // One line per item rather than one for the batch: the audit log is read to answer "what
      // happened to this item", and a batch entry answers that for none of them.
      logAudit(req.user.id, 'item.delete', id, found.row.title);
      deleted += 1;
    }

    req.flash(
      deleted ? 'success' : 'error',
      deleted
        ? `Deleted ${deleted} item${deleted === 1 ? '' : 's'}.`
          + (missing ? ` ${missing} had already gone.` : '')
        : 'None of those items still existed.',
    );
    return res.redirect(backToList(req));
  } catch (error) {
    return next(error);
  }
});

adminRouter.post('/items/:id/delete', async (req, res, next) => {
  try {
    const found = getItem(req.params.id);
    if (!found) return next();

    await deleteItem(req.params.id);
    logAudit(req.user.id, 'item.delete', req.params.id, found.row.title);

    req.flash('success', `Deleted “${found.row.title}”.`);
    return res.redirect(backToList(req, req.params.id));
  } catch (error) {
    return next(error);
  }
});

// MARK: - Tags

adminRouter.get('/tags', (req, res) => {
  res.render('tags', { title: 'Tags', tags: allTags() });
});

// MARK: - Form handling

/**
 * Reads the add/edit form.
 *
 * Everything is normalised through `utils/validate.js` rather than trusted, including the
 * kind — which decides the category list, the accepted extensions and the size ceiling, so a
 * value that got past here would be checked against the wrong rules everywhere downstream.
 */
function readForm(req) {
  const kind = normaliseKind(req.body.kind) || 'skin';

  return {
    kind,
    category: normaliseCategory(kind, req.body.category),
    title: cleanText(req.body.title, 90),
    description: cleanText(req.body.description, 600),
    edition: normaliseEdition(req.body.edition) || 'bedrock',
    mcVersion: normaliseVersion(req.body.mc_version),
    seedCode: kind === 'seed' ? normaliseSeed(req.body.seed_code) : undefined,
    seedMeta: kind === 'seed' ? { highlights: readHighlights(req.body) } : undefined,
    tags: parseTags(req.body.tags),
    isFeatured: req.body.is_featured === 'on',
    isPublished: req.body.is_published === 'on',
  };
}

/**
 * Coordinates worth going to, from the repeating rows on the seed form.
 *
 * Parallel arrays rather than indexed names, because that is what a browser sends for repeated
 * inputs of the same name and it is what the row-adding script can produce without renumbering
 * everything each time a row is removed.
 */
function readHighlights(body) {
  const labels = [].concat(body.highlight_label ?? []);
  const xs = [].concat(body.highlight_x ?? []);
  const ys = [].concat(body.highlight_y ?? []);
  const zs = [].concat(body.highlight_z ?? []);

  const highlights = [];

  for (let index = 0; index < labels.length && highlights.length < 8; index += 1) {
    const label = cleanText(labels[index], 40);
    const x = Number.parseInt(xs[index], 10);
    const z = Number.parseInt(zs[index], 10);

    // A row with no label or no position is an empty row the person did not fill in, not an
    // error to report back at them.
    if (!label || Number.isNaN(x) || Number.isNaN(z)) continue;

    const y = Number.parseInt(ys[index], 10);
    highlights.push({ label, x, y: Number.isNaN(y) ? null : y, z });
  }

  return highlights;
}

function validateForm(form) {
  const errors = [];

  if (!form.title) errors.push('Give it a title.');
  if (!KINDS.includes(form.kind)) errors.push('Pick what kind of item this is.');
  if (!form.category) {
    errors.push(`Pick a category. A ${KIND_LABELS[form.kind]?.toLowerCase() || 'item'} can be: `
      + `${(CATEGORIES[form.kind] || []).join(', ')}.`);
  }
  if (form.kind === 'seed' && !form.seedCode) {
    errors.push('A seed needs its code — the number or word you type into the world creator.');
  }

  return errors;
}

function renderFormErrors(res, req, { mode, form, errors }) {
  return res.status(400).render('items/form', {
    title: mode === 'create' ? 'Add an item' : `Edit ${form.title}`,
    mode,
    item: {
      ...form,
      id: form.id || generateItemId(),
      mc_version: form.mcVersion || '',
      seed_code: form.seedCode || '',
    },
    accepted: ACCEPTED_EXTENSIONS,
    installHints: INSTALL_HINTS,
    knownTags: allTags().slice(0, 30),
    errors,
  });
}

/**
 * One flash for the outcome, with anything the ingest noticed appended.
 *
 * A warning is not a failure — the item saved either way — so it must not read as one. But it
 * has to be seen: "no artwork was supplied" shown as a quiet note nobody reads is how a
 * catalogue fills with grey cards.
 */
function flashWithWarnings(req, warnings, success) {
  if (warnings?.length) {
    req.flash('warning', `${success} ${warnings.join(' ')}`);
  } else {
    req.flash('success', success);
  }
}

function wantsJson(req) {
  return req.xhr || req.get('accept')?.includes('application/json');
}

/**
 * Where to go back to, from a Referer.
 *
 * The Referer is client-supplied, so only a same-host path is ever followed. Taking it as
 * given would turn every one of these redirects into an open redirect.
 */
function backTo(req, fallback) {
  const referer = req.get('referer');
  if (!referer) return fallback;

  try {
    const url = new URL(referer, `${req.protocol}://${req.get('host')}`);
    if (url.host !== req.get('host')) return fallback;
    return url.pathname + url.search;
  } catch {
    return fallback;
  }
}

/**
 * Where to land after deleting.
 *
 * Back to the page it was done from — being thrown to page one having tidied something on page
 * three is its own small punishment. Deleting from the item's own page cannot do that, because
 * that page no longer exists.
 */
function backToList(req, itemId = null) {
  const back = backTo(req, '/admin/items');
  if (itemId && back.startsWith(`/admin/items/${itemId}`)) return '/admin/items';
  return back;
}
