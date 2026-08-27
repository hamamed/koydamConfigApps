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
import {
  designSkin,
  isAvailable as isAiAvailable,
  isPlanningAvailable,
  planDesign,
  availableQualities,
} from '../services/ai/design.js';
import { PUBLISH_CHECKLIST } from '../services/ai/guidelines.js';
import { layoutProof } from '../services/ai/compose.js';

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

/**
 * The stored record of how an AI-designed skin was made.
 *
 * Tolerant: this is displayed, never relied on. A row written by an older
 * version of the planner should show what it can rather than break the page
 * that is the only way to look at the skin.
 */
function parseDesignMeta(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// MARK: - Detail

adminRouter.get('/skins/:id', (req, res, next) => {
  const found = getSkin(req.params.id);
  if (!found) return next();

  // The unwrap, handed to the browser as data rather than reimplemented there.
  // A second copy of these rectangles is how a preview quietly stops matching
  // what Roblox paints — the same reason the seeder and the designer read them
  // from one file.
  return res.render('skins/show', {
    title: found.row.title,
    skin: toAdminShape(found.row, found.tags),
    series: stats.skinSeries(found.row.id, 14),
    reports: reports.reportsForSkin(found.row.id),
    apiUrl: `${config.publicUrl}/api/v1/skins/${found.row.id}`,
    shareUrl: `${config.publicUrl}/s/${found.row.id}`,
    layout: { size: TEMPLATE_SIZE, layouts: LAYOUTS },
    // Only AI-designed skins carry one; everything else shows no plan card.
    design: parseDesignMeta(found.row.design_meta),
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

// ── Design a skin with AI ───────────────────────────────────────────────────

/**
 * The form. Rendered whether or not generation is configured, so someone can
 * see what it would do and what it needs before finding a key.
 */
adminRouter.get('/skins/ai', (req, res) => {
  res.render('skins/ai', {
    title: 'Design a skin',
    available: isAiAvailable(),
    // Planning is a second model on the same key, so it can be off while
    // generation works. The page has to say which of the two it has.
    planningAvailable: isPlanningAvailable(),
    qualities: availableQualities(),
    checklist: PUBLISH_CHECKLIST,
  });
});

/**
 * Generates, composes, and saves as an unpublished draft.
 *
 * Never published directly. Roblox moderates every upload and its decision is
 * the one that counts, so a person looks at this before it is offered to
 * anyone - and the draft is the shape that makes that the default rather than
 * a step someone has to remember.
 */
adminRouter.post('/skins/ai', async (req, res, next) => {
  const description = String(req.body?.description ?? '').trim();
  const category = String(req.body?.category ?? 'shirt');
  const quality = String(req.body?.quality ?? 'standard');
  const title = String(req.body?.title ?? '').trim() || description.slice(0, 60);

  if (!CATEGORIES.includes(category)) {
    if (wantsJson(req)) {
      return res.status(400).json({ status: 'error', message: 'Pick a category.' });
    }
    req.flash('error', 'Pick a category.');
    return res.redirect('/admin/skins/ai');
  }

  try {
    const result = await designSkin({ description, category, quality });

    const id = generateSkinId();
    const base = `${slugify(title, id)}-${id.slice(5)}`;

    // Through the same storage path an upload takes: it re-encodes with sharp,
    // which is what guarantees the bytes really are a PNG and strips whatever
    // metadata the provider attached.
    const stored = await storeTemplate(result.template, `${base}.png`);
    const preview = await storePreview(result.preview, `${base}.webp`);

    createSkin({
      id,
      title,
      category,
      // The description doubles as the record of what was asked for. Someone
      // looking at this in a month should not have to guess where it came from.
      description: `AI generated — “${result.meta.description}”`,
      tags: ['ai'],
      isFeatured: false,
      // The point of the whole flow: it arrives as a draft.
      isPublished: false,
      color: await dominantColor(result.template, category),
      templateFile: stored.filename,
      previewFile: preview.filename,
      templateW: stored.width,
      templateH: stored.height,
      fileBytes: stored.bytes + preview.bytes,
      createdBy: req.user.id,
    });

    logAudit(req.user.id, 'skin.design', id, result.meta.description);

    // The browser form posts and follows a redirect; the in-page flow asks for
    // JSON and navigates itself, so it can keep a progress indicator on screen
    // for the whole generation instead of leaving the tab spinner to say it.
    if (wantsJson(req)) {
      return res.json({ status: 'success', data: { id, location: `/admin/skins/${id}` } });
    }

    req.flash(
      'success',
      'Generated as a draft. Check it against the guidelines, then publish.',
    );
    return res.redirect(`/admin/skins/${id}`);
  } catch (error) {
    // A refused prompt is an answer, not a fault: it should read as guidance
    // rather than as a stack trace in the log.
    //
    // A provider being down, out of credit or rate limiting is worth showing as
    // itself rather than as a generic 500 — the provider's own status code is
    // the thing that tells you whether to retry, top up, or rewrite the prompt.
    const isExpected =
      error.code === 'prompt_rejected' ||
      /provider|configured|rate limit|too long/i.test(error.message);

    if (isExpected) {
      // 502, not 500: the fault is upstream of this service, and saying so is
      // what stops an image provider's bad afternoon reading as a SkinCraft bug.
      if (wantsJson(req)) {
        return res.status(502).json({ status: 'error', message: error.message });
      }
      req.flash('error', error.message);
      return res.redirect('/admin/skins/ai');
    }

    if (wantsJson(req)) {
      console.error(error);
      return res.status(500).json({
        status: 'error',
        message: 'Generation failed. The server log has the detail.',
      });
    }

    return next(error);
  }
});

/**
 * Server-sent events, by hand.
 *
 * `no-transform` is doing real work: the compression middleware buffers a
 * stream to compress it, which turns a live commentary into one silent pause
 * followed by everything at once. It honours that directive; nginx is told
 * separately by X-Accel-Buffering.
 */
function sseOpen(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
}

function sseSend(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * An error after the stream has opened cannot be a status code — the 200 went
 * out with the headers. It has to be an event, and the client has to treat it
 * as one, or a failed generation looks like a stream that simply stopped.
 */
function sseFail(res, error) {
  sseSend(res, { type: 'error', message: error.message });
  res.end();
}

/**
 * Earlier turns of the conversation, made safe to replay.
 *
 * Bounded because it is client-supplied and goes straight into a paid request:
 * without a cap, a tampered-with page could bill the key for an arbitrarily
 * long context. Roles are whitelisted so it cannot smuggle in a second system
 * prompt and rewrite the brief.
 */
function sanitiseHistory(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw || '[]'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-6)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
}

/**
 * Plans the design in words, streamed.
 *
 * Nothing is drawn and nothing is saved. This is the step that exists so the
 * argument about what the design should be happens while it is still free.
 */
adminRouter.post('/skins/ai/plan', async (req, res) => {
  const description = String(req.body?.description ?? '').trim();
  const category = CATEGORIES.includes(String(req.body?.category))
    ? String(req.body.category)
    : 'shirt';

  sseOpen(res);

  if (!isPlanningAvailable()) {
    return sseFail(res, new Error('Planning is not configured. Set a planner model to switch it on.'));
  }

  try {
    const plan = await planDesign(
      { description, category, history: sanitiseHistory(req.body?.history) },
      (delta) => sseSend(res, { type: 'delta', text: delta }),
    );

    sseSend(res, { type: 'plan', reasoning: plan.reasoning, directions: plan.directions });
    return res.end();
  } catch (error) {
    return sseFail(res, error);
  }
});

/**
 * Generates from an approved plan, reporting which image it is on.
 *
 * The directions are passed back in rather than re-planned, so what gets drawn
 * is what was read and agreed to — re-planning here would mean the words on
 * screen described a design nobody generated.
 */
adminRouter.post('/skins/ai/generate', async (req, res) => {
  const description = String(req.body?.description ?? '').trim();
  const category = CATEGORIES.includes(String(req.body?.category))
    ? String(req.body.category)
    : 'shirt';
  const quality = String(req.body?.quality ?? 'standard');
  const title = String(req.body?.title ?? '').trim() || description.slice(0, 60);

  let directions = null;
  try {
    const parsed = JSON.parse(String(req.body?.directions || 'null'));
    if (parsed && typeof parsed === 'object') directions = parsed;
  } catch {
    // A plan that cannot be read is a plan that is not used. The built prompts
    // still produce a skin, which is better than refusing to make one.
  }

  sseOpen(res);

  try {
    const result = await designSkin({
      description,
      category,
      quality,
      directions,
      onProgress: (progress) => sseSend(res, { type: 'progress', ...progress }),
    });

    const id = generateSkinId();
    const base = `${slugify(title, id)}-${id.slice(5)}`;

    sseSend(res, { type: 'progress', stage: 'storing' });

    const stored = await storeTemplate(result.template, `${base}.png`);
    const preview = await storePreview(result.preview, `${base}.webp`);

    createSkin({
      id,
      title,
      category,
      description: `AI generated — “${result.meta.description}”`,
      tags: ['ai'],
      isFeatured: false,
      isPublished: false,
      color: await dominantColor(result.template, category),
      templateFile: stored.filename,
      previewFile: preview.filename,
      templateW: stored.width,
      templateH: stored.height,
      fileBytes: stored.bytes + preview.bytes,
      createdBy: req.user.id,
      designMeta: {
        ...result.meta,
        plan: String(req.body?.plan ?? '').slice(0, 8000) || null,
      },
    });

    logAudit(req.user.id, 'skin.design', id, result.meta.description);

    sseSend(res, { type: 'done', id, location: `/admin/skins/${id}` });
    return res.end();
  } catch (error) {
    if (!(error.code === 'prompt_rejected' || /provider|configured|rate limit|too long/i.test(error.message))) {
      console.error(error);
    }
    return sseFail(res, error);
  }
});

/**
 * The layout proof.
 *
 * Renders each face in its own colour so the geometry can be confirmed by
 * looking, rather than by uploading to Roblox and dressing an avatar. If a
 * face ever lands in the wrong rectangle this shows it immediately; a finished
 * skin hides it until somebody wears the thing.
 */
adminRouter.get('/skins/ai/layout-proof.png', async (req, res, next) => {
  try {
    const category = CATEGORIES.includes(String(req.query.category))
      ? String(req.query.category)
      : 'shirt';

    res.type('image/png');
    res.set('Cache-Control', 'no-store');
    return res.send(await layoutProof(category));
  } catch (error) {
    return next(error);
  }
});
