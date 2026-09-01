import multer from 'multer';

import { MAX_BYTES } from '../wallpapers/store.js';

/**
 * Uploads held in memory, not written straight to disk.
 *
 * The store sniffs the first bytes to decide what a file actually is, and
 * rebuilds its name from a safe alphabet. Neither can happen if multer has
 * already chosen a path and written to it — by then an attacker-supplied name
 * is on the filesystem and the check is after the fact.
 *
 * A 12 MB cap makes memory a non-issue.
 */
export const uploadWallpaper = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
}).single('file');

/** Turns multer's errors into something a person can act on. */
export function handleUploadErrors(err, req, res, next) {
  if (!err) return next();

  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? `That file is larger than ${Math.round(MAX_BYTES / 1024 / 1024)} MB.`
      : 'That upload could not be read.';
    req.flash('danger', message);
    return res.redirect('/admin/wallpapers');
  }
  return next(err);
}
