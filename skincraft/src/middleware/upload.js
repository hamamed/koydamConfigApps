import multer from 'multer';
import { config } from '../config.js';

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * Uploads are buffered in memory rather than written straight to disk.
 *
 * Everything gets re-encoded through sharp anyway, so a disk round trip would only create a
 * window where an unvalidated file sits in the storage tree — and a rejected upload would leave
 * a stray file behind. `MAX_UPLOAD_MB` bounds the memory cost.
 */
export const uploadSkinFiles = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.maxUploadBytes,
    files: 2,
    fields: 20,
  },
  fileFilter(req, file, callback) {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      // The mimetype is only a hint from the client; sharp does the real validation when it
      // decodes the buffer. This just rejects the obvious cases early with a clear message.
      return callback(
        Object.assign(new Error('Templates must be a PNG, JPEG or WebP image.'), { status: 400 })
      );
    }
    return callback(null, true);
  },
}).fields([
  { name: 'template', maxCount: 1 },
  { name: 'preview', maxCount: 1 },
]);

/** Turns multer's own errors into the same shape as everything else in the app. */
export function handleUploadErrors(error, req, res, next) {
  if (error instanceof multer.MulterError) {
    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? `That file is larger than the ${config.maxUploadBytes / (1024 * 1024)} MB limit.`
        : `Upload failed: ${error.message}`;
    return next(Object.assign(new Error(message), { status: 400 }));
  }
  return next(error);
}

/**
 * The single reference picture the AI designer draws from.
 *
 * Its own middleware rather than a third field on `uploadSkinFiles`: that one
 * runs on the save routes where a stray file would be written to storage, and
 * this one runs on a route that only forwards bytes to a provider.
 */
export const uploadReference = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1, fields: 20 },
  fileFilter(req, file, callback) {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return callback(
        Object.assign(new Error('The reference must be a PNG, JPEG or WebP image.'), { status: 400 })
      );
    }
    return callback(null, true);
  },
}).single('reference');
