import express from 'express';
import path from 'node:path';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { requireAuth, verifyCredentials, csrfToken, csrfProtect } from '../middleware/auth.js';
import { uploadSkinFiles, handleUploadErrors } from '../middleware/upload.js';
import {
  listSkins, getSkin, toAdminShape, createSkin, updateSkin,
  toggleFeatured, togglePublished, deleteSkin, allTags, logAudit,
} from '../services/skins.js';
import { storeTemplate, storePreview, derivePreview, dominantColor } from '../services/images.js';
import * as stats from '../services/stats.js';
import * as reports from '../services/reports.js';
import {
  CATEGORIES, CATEGORY_LABELS, normaliseCategory, cleanText,
  clampInt, checkTemplateDimensions,
} from '../utils/validate.js';
import { generateSkinId, slugify, parseTags } from '../utils/ids.js';
import { LAYOUTS, FACE_SHADE, heroRegion, TEMPLATE_SIZE } from '../utils/template-layout.js';
import { REPORT_REASONS } from '../utils/validate.js';

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
  res.locals.categories = CATEGORIES;
  res.locals.categoryLabels = CATEGORY_LABELS;
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
    layout: false,
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
      layout: false,
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

adminRouter.get('/', async (req, res) => {
  res.render('dashboard', {
    title: 'Dashboard',
    overview: stats.overview(),
    series: stats.downloadSeries(14),
    searches: stats.searchInsights(),
    breakdown: stats.categoryBreakdown(),
    top: stats.topSkins(6),
    activity: stats.recentActivity(8),
    storage: await stats.storage(),
    publicUrl: config.publicUrl,
  });
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
    categories: stats.categorySeries(days),
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
  return res.redirect(req.get('referer') || '/admin/reports');
});

adminRouter.post('/skins/:id/reports/resolve', (req, res) => {
  const count = reports.resolveAllForSkin(req.params.id, req.user.id);
  logAudit(req.user.id, 'report.resolveAll', req.params.id, String(count));

  req.flash('success', count === 0 ? 'No open reports.' : `Resolved ${count} report${count === 1 ? '' : 's'}.`);
  return res.redirect(req.get('referer') || `/admin/skins/${req.params.id}`);
});

// MARK: - Skins list

adminRouter.get('/skins', (req, res) => {
  const page = clampInt(req.query.page, { min: 1, max: 10_000, fallback: 1 });
  const search = cleanText(req.query.q, 80);
  const category = normaliseCategory(req.query.category);
  const status = ['published', 'draft', 'featured'].includes(req.query.status)
    ? req.query.status
    : 'all';
  const sort = ['trending', 'newest', 'oldest', 'mostDownloaded', 'title'].includes(req.query.sort)
    ? req.query.sort
    : 'newest';

  const result = listSkins({
    category,
    search: search || null,
    sort,
    featuredOnly: status === 'featured',
    published: status === 'published' ? true : status === 'draft' ? false : null,
    page,
    limit: 24,
  });

  res.render('skins/index', {
    title: 'Skins',
    skins: result.rows.map((row) => toAdminShape(row, result.tags.get(row.id))),
    pagination: {
      page: result.page,
      pageCount: result.pageCount,
      total: result.total,
    },
    filters: { q: search, category: category || '', status, sort },
  });
});

// MARK: - Designer

adminRouter.get('/skins/design', (req, res) => {
  res.render('skins/design', {
    title: 'Design a skin',
    // Handed to the browser as data, so the canvas draws through the same geometry the seeder
    // and the preview deriver use rather than a fourth copy of the coordinates.
    layout: {
      size: TEMPLATE_SIZE,
      layouts: LAYOUTS,
      shade: FACE_SHADE,
      hero: {
        shirt: heroRegion('shirt'),
        tshirt: heroRegion('tshirt'),
        pants: heroRegion('pants'),
      },
    },
  });
});

// MARK: - Create

adminRouter.get('/skins/new', (req, res) => {
  res.render('skins/form', {
    title: 'Upload skin',
    mode: 'create',
    skin: {
      id: generateSkinId(),
      title: '',
      category: 'shirt',
      description: '',
      tags: [],
      isFeatured: false,
      isPublished: true,
    },
    knownTags: allTags().slice(0, 30),
    errors: [],
  });
});

adminRouter.post('/skins', uploadSkinFiles, handleUploadErrors, csrfProtect, async (req, res, next) => {
  try {
    const form = readSkinForm(req);
    const templateFile = req.files?.template?.[0];

    const errors = validateSkinForm(form);
    if (!templateFile) errors.push('A template image is required.');

    if (errors.length) {
      return res.status(400).render('skins/form', {
        title: 'Upload skin',
        mode: 'create',
        skin: { ...form, id: generateSkinId() },
        knownTags: allTags().slice(0, 30),
        errors,
      });
    }

    const id = generateSkinId();
    const base = `${slugify(form.title, id)}-${id.slice(5)}`;

    const stored = await storeTemplate(templateFile.buffer, `${base}.png`);
    const dimensionCheck = checkTemplateDimensions(form.category, stored.width, stored.height);

    // A creator-supplied preview wins; otherwise derive one from the template so no skin ever
    // reaches the app without card artwork.
    const previewUpload = req.files?.preview?.[0];
    const preview = previewUpload
      ? await storePreview(previewUpload.buffer, `${base}.webp`)
      : await derivePreview(templateFile.buffer, `${base}.webp`, form.category);

    createSkin({
      id,
      ...form,
      color: await dominantColor(templateFile.buffer, form.category),
      templateFile: stored.filename,
      previewFile: preview.filename,
      templateW: stored.width,
      templateH: stored.height,
      fileBytes: stored.bytes + preview.bytes,
      createdBy: req.user.id,
    });

    logAudit(req.user.id, 'skin.create', id, form.title);

    req.flash(
      dimensionCheck.warning ? 'warning' : 'success',
      dimensionCheck.warning || `“${form.title}” is live in the catalogue.`
    );
    return res.redirect(`/admin/skins/${id}`);
  } catch (error) {
    return next(error);
  }
});

// MARK: - Detail

adminRouter.get('/skins/:id', (req, res, next) => {
  const found = getSkin(req.params.id);
  if (!found) return next();

  return res.render('skins/show', {
    title: found.row.title,
    skin: toAdminShape(found.row, found.tags),
    series: stats.skinSeries(found.row.id, 14),
    reports: reports.reportsForSkin(found.row.id),
    apiUrl: `${config.publicUrl}/api/v1/skins/${found.row.id}`,
    shareUrl: `${config.publicUrl}/s/${found.row.id}`,
  });
});

// MARK: - Edit

adminRouter.get('/skins/:id/edit', (req, res, next) => {
  const found = getSkin(req.params.id);
  if (!found) return next();

  return res.render('skins/form', {
    title: `Edit ${found.row.title}`,
    mode: 'edit',
    skin: toAdminShape(found.row, found.tags),
    knownTags: allTags().slice(0, 30),
    errors: [],
  });
});

adminRouter.post('/skins/:id', uploadSkinFiles, handleUploadErrors, csrfProtect, async (req, res, next) => {
  try {
    const found = getSkin(req.params.id);
    if (!found) return next();

    const form = readSkinForm(req);
    const errors = validateSkinForm(form);

    if (errors.length) {
      return res.status(400).render('skins/form', {
        title: `Edit ${found.row.title}`,
        mode: 'edit',
        skin: { ...toAdminShape(found.row, found.tags), ...form },
        knownTags: allTags().slice(0, 30),
        errors,
      });
    }

    const patch = { ...form };
    const base = path.parse(found.row.template_file).name;

    // Replacing a file reuses the existing filename, so cached URLs stay valid and no orphan
    // is left behind.
    const templateFile = req.files?.template?.[0];
    if (templateFile) {
      const stored = await storeTemplate(templateFile.buffer, found.row.template_file);
      patch.templateW = stored.width;
      patch.templateH = stored.height;
      patch.fileBytes = stored.bytes;
      patch.color = await dominantColor(templateFile.buffer, form.category);
    }

    const previewUpload = req.files?.preview?.[0];
    if (previewUpload) {
      await storePreview(previewUpload.buffer, found.row.preview_file);
    } else if (templateFile && req.body.regeneratePreview === 'on') {
      await derivePreview(templateFile.buffer, found.row.preview_file, form.category);
    }

    updateSkin(found.row.id, patch);
    logAudit(req.user.id, 'skin.update', found.row.id, form.title);

    req.flash('success', 'Changes saved.');
    return res.redirect(`/admin/skins/${found.row.id}`);
  } catch (error) {
    return next(error);
  }
});

// MARK: - Quick actions

adminRouter.post('/skins/:id/feature', (req, res, next) => {
  const featured = toggleFeatured(req.params.id);
  if (featured === null) return next();

  logAudit(req.user.id, featured ? 'skin.feature' : 'skin.unfeature', req.params.id, null);

  if (wantsJson(req)) return res.json({ status: 'success', data: { featured } });

  req.flash('success', featured ? 'Added to Featured.' : 'Removed from Featured.');
  return res.redirect(req.get('referer') || '/admin/skins');
});

adminRouter.post('/skins/:id/publish', (req, res, next) => {
  const published = togglePublished(req.params.id);
  if (published === null) return next();

  logAudit(req.user.id, published ? 'skin.publish' : 'skin.unpublish', req.params.id, null);

  if (wantsJson(req)) return res.json({ status: 'success', data: { published } });

  req.flash('success', published ? 'Published to the catalogue.' : 'Moved to drafts.');
  return res.redirect(req.get('referer') || '/admin/skins');
});

adminRouter.post('/skins/:id/delete', async (req, res, next) => {
  try {
    const found = getSkin(req.params.id);
    if (!found) return next();

    await deleteSkin(req.params.id);
    logAudit(req.user.id, 'skin.delete', req.params.id, found.row.title);

    req.flash('success', `Deleted “${found.row.title}”.`);
    return res.redirect('/admin/skins');
  } catch (error) {
    return next(error);
  }
});

// MARK: - Tags

adminRouter.get('/tags', (req, res) => {
  res.render('tags', { title: 'Tags', tags: allTags() });
});

// MARK: - Helpers

function readSkinForm(req) {
  return {
    title: cleanText(req.body.title, 80),
    category: normaliseCategory(req.body.category) || 'shirt',
    description: cleanText(req.body.description, 500),
    tags: parseTags(req.body.tags),
    isFeatured: req.body.isFeatured === 'on',
    isPublished: req.body.isPublished === 'on',
  };
}

function validateSkinForm(form) {
  const errors = [];
  if (form.title.length < 3) errors.push('Title must be at least 3 characters.');
  if (!CATEGORIES.includes(form.category)) errors.push('Pick a valid category.');
  return errors;
}

function wantsJson(req) {
  return req.xhr || req.get('accept')?.includes('application/json');
}
