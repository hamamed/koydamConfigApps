import express from 'express';
import path from 'node:path';

import { internalAccess } from '../internal-auth.js';
import { uploadReference, uploadSkinFiles } from '../middleware/upload.js';
import {
  designSkin,
  isAvailable as isAiAvailable,
  isPlanningAvailable,
  availableQualities,
  availableStyles,
  pieceCount,
  planDesign,
  suggestIdeas,
} from '../services/ai/design.js';
import { PUBLISH_CHECKLIST } from '../services/ai/guidelines.js';
import { derivePreview, dominantColor, storePreview, storeTemplate } from '../services/images.js';
import * as reports from '../services/reports.js';
import {
  allTags, createSkin, deleteSkin, getSkin, listSkins, logAudit, toAdminShape,
  toggleFeatured, togglePublished, updateSkin,
} from '../services/skins.js';
import * as stats from '../services/stats.js';
import { generateSkinId, parseTags, slugify } from '../utils/ids.js';
import { CATEGORIES, checkTemplateDimensions, cleanText, clampInt, normaliseCategory } from '../utils/validate.js';
import { FACE_SHADE, heroRegion, LAYOUTS, TEMPLATE_SIZE } from '../utils/template-layout.js';

/**
 * Control routes for the Koydam control panel.
 *
 * The panel manages SkinCraft from now on; this service still keeps the
 * catalogue, renders previews, runs the AI designer and serves the app. These
 * routes are the same operations as the admin pages, as JSON (and as an
 * event stream for the AI steps), for the panel on this machine to call.
 * See internal-auth.js for who may.
 *
 * Who did what is recorded in the audit log under the panel member's email,
 * which the panel sends as X-Panel-Actor.
 */
export const internalRouter = express.Router();

internalRouter.use((req, res, next) => {
  const access = internalAccess(req.headers, process.env.PANEL_TOKEN);
  if (access === 'ok') return next();
  return res.status(access === 'denied' ? 401 : 404).json({ ok: false, error: access === 'denied' ? 'Not authorised.' : 'Not found.' });
});

const ok = (res, data) => res.json({ ok: true, data });
const fail = (res, status, error) => res.status(status).json({ ok: false, error });
const actor = (req) => `panel:${String(req.get('x-panel-actor') ?? 'unknown').slice(0, 120)}`;
/** Upload middleware that answers in JSON instead of the admin pages' redirects. */
const accept = (middleware) => (req, res, next) =>
  middleware(req, res, (err) => (err ? fail(res, err.status ?? 400, err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large.' : err.message) : next()));
const readForm = (body) => ({
  title: cleanText(body.title, 80),
  category: normaliseCategory(body.category) || 'shirt',
  description: cleanText(body.description, 500),
  tags: parseTags(body.tags),
  isFeatured: body.isFeatured === 'true' || body.isFeatured === 'on',
  isPublished: body.isPublished === 'true' || body.isPublished === 'on',
});
const formProblem = (form) => (form.title.length < 3 ? 'Title must be at least 3 characters.' : !CATEGORIES.includes(form.category) ? 'Pick a valid category.' : null);

// ── Overview of what the panel can offer ────────────────────────────────────

internalRouter.get('/meta', (_req, res) => {
  ok(res, {
    categories: CATEGORIES,
    aiAvailable: isAiAvailable(),
    planningAvailable: isPlanningAvailable(),
    qualities: availableQualities(),
    styles: availableStyles(),
    costs: Object.fromEntries(CATEGORIES.map((c) => [c, { garment: pieceCount('garment', null, c), ...Object.fromEntries(availableQualities().map((q) => [q, pieceCount('pattern', q, c)])) }])),
    checklist: PUBLISH_CHECKLIST,
    openReports: reports.openReportCount(),
    layout: { size: TEMPLATE_SIZE, layouts: LAYOUTS, shade: FACE_SHADE, hero: { shirt: heroRegion('shirt'), tshirt: heroRegion('tshirt'), pants: heroRegion('pants') } },
  });
});

// ── Catalogue ───────────────────────────────────────────────────────────────

internalRouter.get('/skins', (req, res) => {
  const status = ['published', 'draft', 'featured'].includes(req.query.status) ? req.query.status : 'all';
  const sort = ['trending', 'newest', 'oldest', 'mostDownloaded', 'title'].includes(req.query.sort) ? req.query.sort : 'newest';
  const result = listSkins({
    category: normaliseCategory(req.query.category),
    search: cleanText(req.query.q, 80) || null,
    sort,
    featuredOnly: status === 'featured',
    published: status === 'published' ? true : status === 'draft' ? false : null,
    page: clampInt(req.query.page, { min: 1, max: 10_000, fallback: 1 }),
    limit: 48,
  });
  ok(res, { skins: result.rows.map((row) => toAdminShape(row, result.tags.get(row.id))), page: result.page, pageCount: result.pageCount, total: result.total });
});

internalRouter.get('/skins/:id', (req, res) => {
  const found = getSkin(req.params.id);
  if (!found) return fail(res, 404, 'No such skin.');
  return ok(res, { skin: toAdminShape(found.row, found.tags), series: stats.skinSeries(found.row.id, 30), reports: reports.reportsForSkin(found.row.id) });
});

internalRouter.post('/skins', accept(uploadSkinFiles), async (req, res) => {
  const form = readForm(req.body ?? {});
  const template = req.files?.template?.[0];
  const problem = formProblem(form) ?? (template ? null : 'A template image is required.');
  if (problem) return fail(res, 400, problem);
  try {
    const id = generateSkinId();
    const base = `${slugify(form.title, id)}-${id.slice(5)}`;
    const stored = await storeTemplate(template.buffer, `${base}.png`);
    const check = checkTemplateDimensions(form.category, stored.width, stored.height);
    const previewUpload = req.files?.preview?.[0];
    const preview = previewUpload ? await storePreview(previewUpload.buffer, `${base}.webp`) : await derivePreview(template.buffer, `${base}.webp`, form.category);
    createSkin({
      id, ...form,
      color: await dominantColor(template.buffer, form.category),
      templateFile: stored.filename, previewFile: preview.filename,
      templateW: stored.width, templateH: stored.height, fileBytes: stored.bytes + preview.bytes,
      createdBy: null,
    });
    logAudit(null, 'skin.create', id, `${form.title} (${actor(req)})`);
    return ok(res, { id, warning: check.warning ?? null });
  } catch (err) {
    console.error(err);
    return fail(res, 500, 'Could not save the skin.');
  }
});

internalRouter.post('/skins/:id', accept(uploadSkinFiles), async (req, res) => {
  const found = getSkin(req.params.id);
  if (!found) return fail(res, 404, 'No such skin.');
  const form = readForm(req.body ?? {});
  const problem = formProblem(form);
  if (problem) return fail(res, 400, problem);
  try {
    const patch = { ...form };
    const template = req.files?.template?.[0];
    if (template) {
      // Same file name as before, so cached addresses stay valid.
      const stored = await storeTemplate(template.buffer, found.row.template_file);
      Object.assign(patch, { templateW: stored.width, templateH: stored.height, fileBytes: stored.bytes, color: await dominantColor(template.buffer, form.category) });
    }
    const previewUpload = req.files?.preview?.[0];
    if (previewUpload) await storePreview(previewUpload.buffer, found.row.preview_file);
    else if (template && req.body.regeneratePreview === 'true') await derivePreview(template.buffer, found.row.preview_file, form.category);
    updateSkin(found.row.id, patch);
    logAudit(null, 'skin.update', found.row.id, `${form.title} (${actor(req)})`);
    return ok(res, { id: found.row.id, base: path.parse(found.row.template_file).name });
  } catch (err) {
    console.error(err);
    return fail(res, 500, 'Could not save the changes.');
  }
});

internalRouter.post('/skins/:id/feature', (req, res) => {
  const featured = toggleFeatured(req.params.id);
  if (featured === null) return fail(res, 404, 'No such skin.');
  logAudit(null, featured ? 'skin.feature' : 'skin.unfeature', req.params.id, actor(req));
  return ok(res, { featured });
});

internalRouter.post('/skins/:id/publish', (req, res) => {
  const published = togglePublished(req.params.id);
  if (published === null) return fail(res, 404, 'No such skin.');
  logAudit(null, published ? 'skin.publish' : 'skin.unpublish', req.params.id, actor(req));
  return ok(res, { published });
});

internalRouter.post('/skins-delete', async (req, res) => {
  const ids = [].concat(req.body?.ids ?? []).map((id) => String(id).trim()).filter(Boolean).slice(0, 200);
  if (!ids.length) return fail(res, 400, 'Nothing was selected.');
  let deleted = 0;
  for (const id of ids) {
    const found = getSkin(id);
    if (!found) continue;
    await deleteSkin(id);
    logAudit(null, 'skin.delete', id, `${found.row.title} (${actor(req)})`);
    deleted += 1;
  }
  return ok(res, { deleted, missing: ids.length - deleted });
});

internalRouter.get('/tags', (_req, res) => ok(res, { tags: allTags() }));

// ── Insight ─────────────────────────────────────────────────────────────────

internalRouter.get('/analytics', async (req, res) => {
  const days = [7, 14, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 14;
  ok(res, {
    days,
    overview: stats.overview(),
    summary: stats.periodSummary(days),
    downloads: stats.downloadSeries(days),
    uniques: stats.uniqueClientSeries(days),
    categories: stats.categoryBreakdown(),
    top: stats.topSkins(8),
    movers: stats.topMovers({ days }),
    tags: stats.tagPerformance({ days }),
    searches: stats.searchInsights({ days, limit: 10 }),
    reasons: reports.reasonBreakdown({ days }),
    flagged: reports.mostReported(5),
    storage: await stats.storage().catch(() => null),
  });
});

internalRouter.get('/reports', (req, res) => {
  const status = ['open', 'resolved', 'dismissed', 'all'].includes(req.query.status) ? req.query.status : 'open';
  const result = reports.listReports({ status, page: clampInt(req.query.page, { min: 1, max: 10_000, fallback: 1 }), limit: 25 });
  ok(res, { ...result, status, openCount: reports.openReportCount() });
});

internalRouter.post('/reports/:id/status', (req, res) => {
  const status = String(req.body?.status ?? '');
  if (!['open', 'resolved', 'dismissed'].includes(status) || !reports.setReportStatus(Number(req.params.id), status, null)) return fail(res, 404, 'No such report.');
  logAudit(null, `report.${status}`, req.params.id, actor(req));
  return ok(res, { id: Number(req.params.id), status });
});

internalRouter.post('/skins/:id/reports/resolve', (req, res) => {
  const count = reports.resolveAllForSkin(req.params.id, null);
  logAudit(null, 'report.resolveAll', req.params.id, `${count} (${actor(req)})`);
  ok(res, { resolved: count });
});

// ── AI designer: the same three steps as the admin page ─────────────────────

const HEARTBEAT_MS = 15_000;
function sseOpen(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  const beat = setInterval(() => !res.writableEnded && !res.destroyed && res.write(': keep-alive\n\n'), HEARTBEAT_MS);
  beat.unref?.();
  res.on('close', () => clearInterval(beat));
  res.on('finish', () => clearInterval(beat));
}
const sseSend = (res, payload) => !res.writableEnded && !res.destroyed && res.write(`data: ${JSON.stringify(payload)}\n\n`);
const sseFail = (res, error) => {
  sseSend(res, { type: 'error', message: error.message });
  if (!res.writableEnded) res.end();
};
const readCategory = (v) => (CATEGORIES.includes(String(v)) ? String(v) : 'shirt');
const readStyle = (v) => (String(v ?? '') === 'garment' ? 'garment' : 'pattern');
const expected = (error) => error.code === 'prompt_rejected' || /provider|configured|rate limit|too long|reference/i.test(error.message);

function sanitiseHistory(raw) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-6)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
}

internalRouter.post('/ai/ideas', async (req, res) => {
  if (!isPlanningAvailable()) return fail(res, 503, 'Ideas need a planner model, which is not configured on the SkinCraft service.');
  try {
    const ideas = await suggestIdeas({ theme: String(req.body?.theme ?? '').slice(0, 200), category: readCategory(req.body?.category) });
    return ideas.length ? ok(res, { ideas }) : fail(res, 502, 'The planner replied, but nothing in it could be read as an idea. Try again.');
  } catch (error) {
    return fail(res, error.code === 'prompt_rejected' ? 400 : 502, error.message);
  }
});

internalRouter.post('/ai/plan', async (req, res) => {
  sseOpen(res);
  if (!isPlanningAvailable()) return sseFail(res, new Error('Planning is not configured on the SkinCraft service.'));
  try {
    const plan = await planDesign(
      { description: String(req.body?.description ?? '').trim(), category: readCategory(req.body?.category), style: readStyle(req.body?.style), history: sanitiseHistory(req.body?.history) },
      (delta) => sseSend(res, { type: 'delta', text: delta }),
    );
    sseSend(res, { type: 'plan', reasoning: plan.reasoning, directions: plan.directions });
    return res.end();
  } catch (error) {
    return sseFail(res, error);
  }
});

/**
 * Generates and saves a draft, from the AI page (`mode=design`, with an
 * optional approved plan) or from a single picture (`mode=picture`).
 * Never published directly: a person checks every generated skin first.
 */
internalRouter.post('/ai/generate', accept(uploadReference), async (req, res) => {
  const mode = req.body?.mode === 'picture' ? 'picture' : 'design';
  const category = readCategory(req.body?.category);
  const notes = String(req.body?.notes ?? '').trim();
  const description = mode === 'picture' ? (notes ? `Match the colours, patterns and mood of the reference image. ${notes}` : 'Match the colours, patterns and mood of the reference image.') : String(req.body?.description ?? '').trim();
  const title = String(req.body?.title ?? '').trim() || (mode === 'picture' ? 'From a picture' : description.slice(0, 60));
  let directions = null;
  try {
    const parsed = JSON.parse(String(req.body?.directions || 'null'));
    if (parsed && typeof parsed === 'object') directions = parsed;
  } catch {}

  sseOpen(res);
  if (mode === 'picture' && !req.file?.buffer?.length) return sseFail(res, new Error('Choose a picture first.'));
  // The images are paid for as they are drawn: if the panel goes away, finish and save the draft anyway.
  res.on('close', () => !res.writableEnded && console.warn('  Generation continuing after the panel disconnected; the draft will be saved.'));
  try {
    const result = await designSkin({
      reference: req.file?.buffer ?? null,
      description,
      category,
      quality: mode === 'picture' ? 'standard' : String(req.body?.quality ?? 'standard'),
      style: mode === 'picture' ? 'pattern' : readStyle(req.body?.style),
      directions: mode === 'picture' ? null : directions,
      onProgress: (progress) => sseSend(res, { type: 'progress', ...progress }),
    });
    sseSend(res, { type: 'progress', stage: 'storing' });
    const id = generateSkinId();
    const base = `${slugify(title, id)}-${id.slice(5)}`;
    const stored = await storeTemplate(result.template, `${base}.png`);
    const preview = await storePreview(result.preview, `${base}.webp`);
    createSkin({
      id, title, category,
      description: mode === 'picture' ? (notes ? `Made from a picture — “${notes}”` : 'Made from a picture.') : `AI generated — “${result.meta.description}”`,
      tags: mode === 'picture' ? ['ai', 'from-picture'] : ['ai'],
      isFeatured: false,
      isPublished: false,
      color: await dominantColor(result.template, category),
      templateFile: stored.filename, previewFile: preview.filename,
      templateW: stored.width, templateH: stored.height, fileBytes: stored.bytes + preview.bytes,
      createdBy: null,
      ...(mode === 'design' ? { designMeta: { ...result.meta, plan: String(req.body?.plan ?? '').slice(0, 8000) || null } } : {}),
    });
    logAudit(null, mode === 'picture' ? 'skin.from-picture' : 'skin.design', id, `${(notes || result.meta.description || '').slice(0, 200)} (${actor(req)})`);
    sseSend(res, { type: 'done', id });
    return res.end();
  } catch (error) {
    if (!expected(error)) console.error(error);
    return sseFail(res, expected(error) ? error : new Error('Something went wrong making that draft.'));
  }
});
