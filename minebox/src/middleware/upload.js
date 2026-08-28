import multer from 'multer';
import { config } from '../config.js';
import { FORMATS, extensionOf } from '../utils/validate.js';

const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * Uploads are buffered in memory rather than written straight to disk.
 *
 * A preview is re-encoded through sharp and an archive is read by the ZIP inspector, so both
 * are held in full anyway. A disk round trip would only create a window where an unvalidated
 * file sits in the storage tree, and a rejected upload would leave a stray file behind.
 * `MAX_UPLOAD_MB` bounds the memory cost; per-kind ceilings are enforced in `services/files.js`
 * once the kind is known.
 */
export const uploadItemFiles = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.maxUploadBytes,
    files: 2,
    fields: 40,
  },
  fileFilter(req, file, callback) {
    if (file.fieldname === 'preview') {
      if (IMAGE_MIME.has(file.mimetype)) return callback(null, true);
      return callback(reject('The card image must be a PNG, JPEG or WebP.'));
    }

    // The payload is checked by *extension*, not by mimetype. A browser has no idea what a
    // .mcaddon is and sends `application/octet-stream` for every one of them, so a mimetype
    // allowlist here would reject the entire catalogue. The extension is only a claim too —
    // the archive inspector and the skin reader are what actually prove it — but it is enough
    // to turn away an .exe before it is read into memory.
    const ext = extensionOf(file.originalname);
    if (Object.hasOwn(FORMATS, ext)) return callback(null, true);

    return callback(reject(
      `MineBox does not take ${ext || 'files with no extension'}. `
      + `Upload one of: ${Object.keys(FORMATS).join(', ')}.`,
    ));
  },
}).fields([
  { name: 'file', maxCount: 1 },
  { name: 'preview', maxCount: 1 },
]);

function reject(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/** Turns multer's own errors into the same shape as everything else in the app. */
export function handleUploadErrors(error, req, res, next) {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? `That file is larger than the ${config.maxUploadBytes / (1024 * 1024)} MB limit.`
      : `Upload failed: ${error.message}`;
    return next(Object.assign(new Error(message), { status: 400 }));
  }
  return next(error);
}
