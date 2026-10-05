import { Router } from 'express';
import multer from 'multer';

import { cacheDel } from '../cache/store.js';
import { browseTable } from '../db/browse_repo.js';
import { internalAccess } from '../internal-auth.js';
import { log } from '../log.js';
import { panelData } from '../panel-data.js';
import { deleteWallpaper, MAX_BYTES, storeWallpaper } from '../wallpapers/store.js';
import { catalogRouter } from './catalog.js';
import { scanGallery } from './wallpapers.js';

/**
 * Control routes for the company control panel (Koydam Control), which runs
 * on this machine and calls the service on its local port.
 *
 * Nothing here is reachable from the internet: see internal-auth.js. Each
 * route does what the old panel under /admin does, through the same
 * functions, so there is one implementation of every action.
 */
export const internalRouter = Router();

internalRouter.use((req, res, next) => {
  const access = internalAccess(req.headers, process.env.PANEL_TOKEN);
  if (access === 'ok') return next();
  // Outside callers and a missing token both get "not found": the routes
  // should not even be discoverable from the internet.
  return res.status(access === 'denied' ? 401 : 404).json({ ok: false, error: access === 'denied' ? 'Not authorised.' : 'Not found.' });
});

/** Who in the control panel did it, for the log. */
const actor = (req) => String(req.headers['x-panel-actor'] ?? 'panel').slice(0, 120);
const ok = (res, data) => res.json({ ok: true, data });
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

/** Crawler, meta standings, movers, storage and row counts: the old dashboard in one read. */
internalRouter.get('/overview', wrap(async (_req, res) => ok(res, await panelData())));

/** The newest rows of one whitelisted table. */
internalRouter.get('/table/:name', wrap(async (req, res) => {
  const result = await browseTable(req.params.name, req.query.limit);
  if (!result) return res.status(404).json({ ok: false, error: 'Not a browsable table.' });
  return ok(res, result);
}));

internalRouter.get('/wallpapers', wrap(async (_req, res) => {
  const gallery = await scanGallery();
  return ok(res, { categories: gallery.categories, items: gallery.items, totalBytes: gallery.items.reduce((n, i) => n + (i.bytes ?? 0), 0), maxBytes: MAX_BYTES });
}));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 12 } });

internalRouter.post('/wallpapers', (req, res, next) => upload.array('files', 12)(req, res, (err) => (err ? res.status(400).json({ ok: false, error: err.code === 'LIMIT_FILE_SIZE' ? 'One of the files is too large.' : err.message }) : next())), wrap(async (req, res) => {
  const files = req.files ?? [];
  if (!files.length) return res.status(400).json({ ok: false, error: 'Choose at least one image.' });
  const category = req.body?.category ?? '';
  const stored = [];
  const failed = [];
  // One at a time: these are disk writes on a small server.
  for (const file of files) {
    const result = await storeWallpaper({ buffer: file.buffer, filename: file.originalname, category });
    if (result.ok) stored.push(result.id);
    else failed.push({ name: file.originalname, reason: result.reason });
  }
  // The public index is cached; without this a new wallpaper looks like a failed upload.
  if (stored.length) await cacheDel('wallpapers:index');
  log.info('Wallpapers uploaded', { by: `panel:${actor(req)}`, stored: stored.length, failed: failed.length });
  return ok(res, { stored, failed });
}));

internalRouter.delete('/wallpapers/:id(*)', wrap(async (req, res) => {
  const result = await deleteWallpaper(req.params.id);
  if (!result.ok) return res.status(400).json({ ok: false, error: result.reason });
  await cacheDel('wallpapers:index');
  log.info('Wallpaper deleted', { by: `panel:${actor(req)}`, id: result.id });
  return ok(res, { id: result.id });
}));

// The app's own catalogue (brawlers, maps, game modes, tier list), read by the
// control panel to keep its copy current. Same handlers the app is served by.
internalRouter.use('/catalog', catalogRouter);

internalRouter.use((err, _req, res, _next) => {
  log.error('Control route failed', { error: err?.message });
  res.status(500).json({ ok: false, error: 'That did not work. See the service log.' });
});
