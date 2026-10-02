/**
 * Adds a folder of finished templates to the catalogue.
 *
 * For a batch made elsewhere — the iOS editor's renderer, a designer's export folder — where
 * uploading a hundred files through the panel one at a time is not a plan. Each file goes
 * through exactly what an upload goes through: re-encoded, a card derived from it, its dominant
 * colour sampled. Nothing is written straight into the database.
 *
 * The folder holds the PNGs and a `manifest.json`:
 *
 *   [{ "file": "001-midnight-hoodie.png", "title": "Midnight Hoodie", "category": "shirt",
 *      "tags": ["hoodie", "purple"], "description": "…" }]
 *
 * Safe to run twice: a title already in the catalogue is skipped, so a batch that failed
 * halfway can simply be run again.
 *
 * Unlike the seeder this invents no download history. These are real catalogue entries, and
 * their counts should be the ones real people give them.
 *
 * Usage:  npm run import-skins -- <folder> [--dry-run]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { db, migrate } from './index.js';
import { createSkin } from '../services/skins.js';
import { ensureStorageDirs, storeTemplate, derivePreview, dominantColor } from '../services/images.js';
import { generateSkinId, slugify } from '../utils/ids.js';
import { TEMPLATE_SIZE } from '../utils/template-layout.js';

const CATEGORIES = new Set(['shirt', 'pants', 'tshirt', 'avatar']);

const folder = process.argv[2];
const isDryRun = process.argv.includes('--dry-run');

if (!folder || folder.startsWith('--')) {
  console.error('  Usage: npm run import-skins -- <folder> [--dry-run]');
  process.exit(1);
}

/** Rejects a manifest entry that would produce a broken catalogue row. */
function problemWith(entry) {
  if (!entry || typeof entry !== 'object') return 'not an object';
  if (typeof entry.title !== 'string' || !entry.title.trim()) return 'missing title';
  if (!CATEGORIES.has(entry.category)) return `unknown category "${entry.category}"`;
  // A bare filename only — the manifest must not be able to read outside its own folder.
  if (typeof entry.file !== 'string' || path.basename(entry.file) !== entry.file) {
    return `bad file name "${entry.file}"`;
  }
  if (entry.tags !== undefined && !Array.isArray(entry.tags)) return 'tags must be a list';
  return null;
}

let manifest;
try {
  manifest = JSON.parse(await fs.readFile(path.join(folder, 'manifest.json'), 'utf8'));
} catch (error) {
  console.error(`  Could not read ${path.join(folder, 'manifest.json')}: ${error.message}`);
  process.exit(1);
}
if (!Array.isArray(manifest)) {
  console.error('  manifest.json must be a list of skins.');
  process.exit(1);
}

migrate();
await ensureStorageDirs();

const author = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
const titleExists = db.prepare('SELECT 1 FROM skins WHERE title = ? LIMIT 1');

const summary = { added: 0, skipped: 0, failed: 0 };

for (const [index, entry] of manifest.entries()) {
  const label = entry?.title || `entry ${index + 1}`;

  const problem = problemWith(entry);
  if (problem) {
    console.error(`  ✗ ${label}: ${problem}`);
    summary.failed += 1;
    continue;
  }
  if (titleExists.get(entry.title.trim())) {
    summary.skipped += 1;
    continue;
  }

  try {
    const png = await fs.readFile(path.join(folder, entry.file));

    if (isDryRun) {
      summary.added += 1;
      continue;
    }

    const id = generateSkinId();
    const title = entry.title.trim();
    const base = `${slugify(title, id)}-${id.slice(5)}`;

    const stored = await storeTemplate(png, `${base}.png`);
    if (stored.width !== TEMPLATE_SIZE.width || stored.height !== TEMPLATE_SIZE.height) {
      console.warn(`  ! ${label}: template is ${stored.width}×${stored.height}, not 585×559`);
    }
    const preview = await derivePreview(png, `${base}.webp`, entry.category);

    createSkin({
      id,
      title,
      color: await dominantColor(png, entry.category),
      category: entry.category,
      description: typeof entry.description === 'string' ? entry.description : '',
      tags: entry.tags || [],
      templateFile: stored.filename,
      previewFile: preview.filename,
      templateW: stored.width,
      templateH: stored.height,
      fileBytes: stored.bytes + preview.bytes,
      isFeatured: entry.featured === true,
      isPublished: entry.published !== false,
      createdBy: author?.id ?? null,
    });
    summary.added += 1;
  } catch (error) {
    console.error(`  ✗ ${label}: ${error.message}`);
    summary.failed += 1;
  }
}

const verb = isDryRun ? 'would add' : 'added';
console.log(`  ${verb} ${summary.added}, skipped ${summary.skipped} already there, ${summary.failed} failed.`);
process.exit(summary.failed > 0 ? 1 : 0);
