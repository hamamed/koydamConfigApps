import express from 'express';
import multer from 'multer';

import { db } from '../db/index.js';
import { csrfProtect } from '../middleware/auth.js';
import { filterOptions, pageHref, queryGallery, readFilters, videoTotals } from '../gallery.js';
import { SHOWCASE_ROOT, showcaseClips } from '../showcase.js';
import { MAX_CLIP_BYTES, createClipStore } from '../showcase-store.js';

/**
 * The catalogue browser and the videos gallery.
 *
 * One query and one card serve both. The catalogue rows stay read-only — they
 * mirror upstream and any edit would be overwritten by the next sync — but a
 * rendered clip is this service's own file, so the videos page can add and
 * remove those.
 *
 * Mounted on the admin router after sign-in and CSRF, so both apply here.
 */
export const galleryRouter = express.Router();

/** Ten at twenty megabytes stays under nginx's 260m body limit for /admin/. */
const MAX_CLIP_FILES = 10;

const VIDEO_TABS = [
  { value: 'any', label: 'All videos', icon: 'film' },
  { value: 'clip', label: 'Clips', icon: 'clapperboard' },
  { value: 'youtube', label: 'YouTube', icon: 'youtube' },
  { value: 'none', label: 'No video', icon: 'circle-off' },
];

/** Where a delete may send the browser back to. Anything else goes to /admin/videos. */
const RETURN_PATH = /^\/admin\/(?:videos|cosmetics)(?:\?[\w%&=.+-]*)?$/;

const clipStore = createClipStore(SHOWCASE_ROOT, {
  isKnownId: (id) => Boolean(db.prepare('SELECT 1 FROM cosmetics WHERE id = ?').get(id)),
});

// In memory for the same reason as wallpapers: the store checks the bytes and
// the name before anything touches the disk.
const uploadClips = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CLIP_BYTES, files: MAX_CLIP_FILES },
}).array('file', MAX_CLIP_FILES);

function handleClipUploadErrors(err, req, res, next) {
  if (!err) return next();
  if (!(err instanceof multer.MulterError)) return next(err);

  const message = err.code === 'LIMIT_FILE_SIZE'
    ? `One of those files is larger than ${Math.round(MAX_CLIP_BYTES / 1024 / 1024)} MB.`
    : err.code === 'LIMIT_FILE_COUNT'
      ? `That is more than ${MAX_CLIP_FILES} files. Upload them in smaller batches.`
      : 'That upload could not be read.';
  req.flash('danger', message);
  return res.redirect('/admin/videos');
}

galleryRouter.get('/cosmetics', (req, res) => {
  const filters = readFilters(req.query);
  const result = queryGallery(db, filters, showcaseClips.ids(), {
    clipUrl: showcaseClips.pathFor,
    clipSource: showcaseClips.sourceOf,
  });

  res.render('cosmetics', {
    title: 'Catalogue',
    filters,
    result,
    options: filterOptions(db),
    hrefFor: (page) => pageHref('/admin/cosmetics', filters, page),
    returnTo: req.originalUrl,
  });
});

galleryRouter.get('/videos', (req, res) => {
  const read = readFilters(req.query);
  // The tabs are the video filter here, and the page opens on all of them.
  const filters = { ...read, video: read.video || 'any' };
  const clipIds = showcaseClips.ids();

  res.render('videos', {
    title: 'Videos',
    filters,
    result: queryGallery(db, filters, clipIds, { clipUrl: showcaseClips.pathFor, clipSource: showcaseClips.sourceOf }),
    totals: videoTotals(db, clipIds, showcaseClips.idsFrom('youtube')),
    options: filterOptions(db),
    tabs: VIDEO_TABS,
    hrefFor: (page) => pageHref('/admin/videos', filters, page),
    // `clear` keeps the tab and drops the search and filters.
    tabHref: (video, clear = false) =>
      pageHref('/admin/videos', clear ? { ...readFilters({}), video } : { ...filters, video }, 1),
    maxClipMb: Math.round(MAX_CLIP_BYTES / 1024 / 1024),
    maxClipFiles: MAX_CLIP_FILES,
    returnTo: req.originalUrl,
  });
});

galleryRouter.post('/videos/upload', uploadClips, handleClipUploadErrors, csrfProtect, async (req, res) => {
  const files = req.files ?? [];
  if (!files.length) {
    req.flash('danger', 'Choose at least one MP4 to upload.');
    return res.redirect('/admin/videos');
  }

  // One at a time, and a bad file does not sink the rest — see wallpapers.
  const stored = [];
  const failed = [];
  for (const file of files) {
    const result = await clipStore.storeClip({ buffer: file.buffer, filename: file.originalname });
    if (result.ok) stored.push(result);
    else failed.push(`${file.originalname}: ${result.reason}`);
  }

  if (stored.length) await showcaseClips.reload();

  const replaced = stored.filter((s) => s.replaced).length;
  const saved = `Uploaded ${stored.length} clip${stored.length === 1 ? '' : 's'}` +
    (replaced ? ` (${replaced} replaced)` : '') + '.';
  const rejected = `${failed.length} could not be saved — ${failed.join('; ')}`;

  // One flash holds one message, so a partial batch reports both halves in it.
  if (failed.length && stored.length) req.flash('warning', `${saved} ${rejected}`);
  else if (failed.length) req.flash('danger', rejected);
  else req.flash('success', saved);

  return res.redirect('/admin/videos?video=clip');
});

galleryRouter.post('/videos/delete', async (req, res) => {
  const result = await clipStore.deleteClip(String(req.body?.id ?? ''));
  if (result.ok) {
    await showcaseClips.reload();
    req.flash('success', `Deleted the clip for ${result.id}.`);
  } else {
    req.flash('danger', result.reason);
  }

  const back = String(req.body?.return ?? '');
  return res.redirect(RETURN_PATH.test(back) ? back : '/admin/videos');
});
