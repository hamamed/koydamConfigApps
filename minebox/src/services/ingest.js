/**
 * Turning an upload into stored files.
 *
 * Five kinds arrive through one form, and each needs something different done to it: a skin is
 * decoded and drawn, an archive is opened and checked, a seed has no file at all. This is the
 * one place that knows which is which, so the route can read as "validate the form, ingest the
 * upload, write the row" for every kind alike.
 *
 * Nothing here touches the database. It returns the columns to store, and the caller decides
 * whether to create a row or update one — which is what lets the edit form replace a file
 * without duplicating any of this.
 */

import { extensionOf, FORMATS, checkExtension, hasFile } from '../utils/validate.js';
import { slugify } from '../utils/ids.js';
import { storeFile } from './files.js';
import { renderSkinCard, renderIconCard, storeUploadedPreview, renderPlaceholderCard } from './previews.js';
import { inspectArchive } from './packs.js';

/**
 * @param {object} input
 * @param {string} input.id            the item id, already generated
 * @param {string} input.kind
 * @param {string} input.title         used for the stored filename, so uploads stay identifiable
 * @param {Buffer|null} input.fileBuffer
 * @param {string|null} input.originalName
 * @param {Buffer|null} input.previewBuffer
 * @param {object|null} input.existing when editing: the row being replaced, so filenames are reused
 */
export async function ingest({
  id, kind, title, fileBuffer, originalName, previewBuffer, existing = null,
}) {
  const warnings = [];

  // Filenames are stable per item. Replacing a file reuses the name it already had, so cached
  // URLs stay valid, no orphan is left behind, and the CDN does not serve the old bytes under
  // a new name while the new bytes sit under the old one.
  const base = existing
    ? stripExtension(existing.preview_file)
    : `${slugify(title, id)}-${id.slice(3)}`;

  const stored = { warnings };

  if (hasFile(kind) && fileBuffer) {
    const ext = extensionOf(originalName);
    const problem = checkExtension(kind, originalName);
    if (problem) throw fault(problem);

    const format = FORMATS[ext];

    // ── The payload ─────────────────────────────────────────────────────────
    //
    // Checked before it is written, so a rejected upload leaves nothing behind. A skin is
    // decoded here for the same reason: an image that is not 64×64 fails now rather than
    // becoming a published item that Minecraft refuses to wear.
    if (format?.zip) {
      const inspected = inspectArchive(fileBuffer, { install: format.install });
      warnings.push(...inspected.warnings);
      stored.packMeta = inspected.packs.length ? { packs: inspected.packs } : null;
      stored.archiveIcon = inspected.icon;
    }

    const file = await storeFile(fileBuffer, `${base}${ext}`, kind);
    stored.fileName = file.filename;
    stored.originalName = originalName;
    stored.fileExt = file.ext;
    stored.fileBytes = file.bytes;
  }

  // ── Card artwork ──────────────────────────────────────────────────────────
  //
  // In order of preference: what the admin uploaded, then what can be derived from the item
  // itself, then a generated card. The last of those is why `preview_file` is NOT NULL — every
  // path here produces one, so nothing in the catalogue is ever without a picture.
  const previewName = `${base}.webp`;

  if (previewBuffer) {
    const preview = await storeUploadedPreview(previewBuffer, previewName);
    stored.previewFile = preview.filename;
    stored.color = preview.color;
  } else if (kind === 'skin' && fileBuffer && extensionOf(originalName) === '.png') {
    // The skin is drawn as a front-facing portrait, and the texture's own properties fall out
    // of the same decode — so the model and dimensions are recorded without reading it twice.
    const card = await renderSkinCard(fileBuffer, previewName);
    stored.previewFile = card.filename;
    stored.color = card.color;
    stored.skinModel = card.model;
    stored.skinW = card.width;
    stored.skinH = card.height;
    if (card.legacy) {
      warnings.push(
        'That skin is the old 64×32 layout. It works, but it has no second layer and no left '
        + 'arm of its own — the right one is mirrored.',
      );
    }
  } else if (stored.archiveIcon) {
    // A pack_icon.png is whatever the pack author put in the archive under that name, and
    // "not actually an image" is a real thing to find there. That is a missing icon, not a
    // broken upload — failing the whole item over it would refuse a pack Minecraft installs
    // perfectly well, for a picture we were only borrowing.
    try {
      const card = await renderIconCard(stored.archiveIcon, previewName);
      stored.previewFile = card.filename;
      stored.color = card.color;
    } catch {
      warnings.push("The pack's own pack_icon.png could not be read, so a plain card was generated.");
    }
  }

  // Nothing above produced one, and nothing already exists to keep.
  if (!stored.previewFile && (!existing || !existing.preview_file)) {
    const card = await renderPlaceholderCard(previewName, { kind, title });
    stored.previewFile = card.filename;
    stored.color = card.color;
    if (!warnings.length) {
      warnings.push('No artwork was supplied, so a plain card was generated. Upload an image to replace it.');
    }
  }

  // Not a column; it only existed to choose a preview.
  delete stored.archiveIcon;

  return stored;
}

function stripExtension(filename) {
  return String(filename || '').replace(/\.[a-z0-9]+$/i, '');
}

function fault(message) {
  return Object.assign(new Error(message), { status: 400 });
}
