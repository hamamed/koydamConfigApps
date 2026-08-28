import crypto from 'node:crypto';

/**
 * Catalogue ids look like `mb_a7f3c9d2e1b4`.
 *
 * Deliberately random rather than sequential: ids appear in public URLs, and sequential ids
 * leak how many items exist and invite scraping by enumeration.
 */
export function generateItemId() {
  return `mb_${crypto.randomBytes(6).toString('hex')}`;
}

/** Filesystem-safe slug used for stored filenames, so uploads stay identifiable on disk. */
export function slugify(input, fallback = 'item') {
  const slug = String(input || '')
    .normalize('NFKD')
    // Combining marks left behind by the decomposition above, so "Café" slugs as "cafe"
    // rather than as "cafe" with a floating accent the filesystem then keeps.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

/** Normalises a free-text tag input ("Dragons, magic , DRAGONS") into a clean, unique list. */
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

/**
 * A download filename that is safe to put in a Content-Disposition header.
 *
 * Minecraft shows a pack under whatever the file is called, so the uploader's name is worth
 * keeping — but it arrives from a browser and may contain quotes, newlines or path separators,
 * each of which can either split the header or walk out of the storage directory.
 */
export function safeDownloadName(name, fallback) {
  const cleaned = String(name || '')
    .replace(/[\\/]/g, '-')
    // Control characters and quotes, written as escapes rather than as a literal
    // range: a range spelled with the characters themselves is invisible in a diff, and a
    // newline smuggled into a filename would end the header and let the rest of the name be
    // read as a header of its own.
    .replace(/[\u0000-\u001f\u007f"']/g, '')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}
