import crypto from 'node:crypto';

/**
 * Catalogue ids look like `skin_a7f3c9d2e1b4`.
 *
 * Deliberately random rather than sequential: ids appear in public URLs, and sequential ids
 * leak how many assets exist and invite scraping by enumeration.
 */
export function generateSkinId() {
  return `skin_${crypto.randomBytes(6).toString('hex')}`;
}

/** Filesystem-safe slug used for stored filenames, so uploads stay identifiable on disk. */
export function slugify(input, fallback = 'skin') {
  const slug = String(input || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

/** Normalises a free-text tag input ("Neon, cyberpunk , NEON") into a clean, unique list. */
export function parseTags(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(',');
  const seen = new Set();

  for (const value of raw) {
    const tag = String(value)
      .trim()
      .toLowerCase()
      .replace(/^#/, '')
      .replace(/[^a-z0-9\- ]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 24);
    if (tag) seen.add(tag);
  }
  return [...seen].slice(0, 12);
}
