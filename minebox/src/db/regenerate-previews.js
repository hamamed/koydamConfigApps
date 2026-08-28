/**
 * Redraws every card image from the file it came from.
 *
 *   npm run regenerate-previews
 *   npm run regenerate-previews -- skin
 *
 * Run this after changing anything in `services/previews.js` or `utils/minecraft-skin.js` —
 * the card size, the backdrop, the portrait geometry. Previews are drawn once at upload time
 * and then never again, so a rendering improvement reaches nothing already in the catalogue
 * until this is run.
 *
 * Skipped rather than failed for anything whose source file has gone: an item whose archive is
 * missing has a bigger problem than its thumbnail, and stopping the whole run over one of them
 * would leave the catalogue half redrawn.
 */

import fs from 'node:fs/promises';
import { db, migrate } from './index.js';
import { pathFor } from '../services/files.js';
import { renderSkinCard, renderIconCard, renderPlaceholderCard } from '../services/previews.js';
import { inspectArchive } from '../services/packs.js';
import { FORMATS } from '../utils/validate.js';

const only = process.argv[2] || null;

migrate();

const rows = db
  .prepare(
    `SELECT id, kind, title, file_name, file_ext, preview_file
       FROM items ${only ? 'WHERE kind = ?' : ''}
   ORDER BY created_at`,
  )
  .all(...(only ? [only] : []));

console.log(`  ${rows.length} item${rows.length === 1 ? '' : 's'} to redraw…`);

let redrawn = 0;
let skipped = 0;

for (const row of rows) {
  try {
    // Reuses the existing filename, so every cached URL and every stored row stays valid.
    const name = row.preview_file;

    if (!row.file_name) {
      await renderPlaceholderCard(name, { kind: row.kind, title: row.title });
      redrawn += 1;
      continue;
    }

    const absolute = pathFor(row.file_name);
    const buffer = absolute ? await fs.readFile(absolute) : null;

    if (!buffer) {
      console.warn(`  ! ${row.id} (${row.title}) — its file is missing, left alone`);
      skipped += 1;
      continue;
    }

    if (row.kind === 'skin' && row.file_ext === '.png') {
      await renderSkinCard(buffer, name);
    } else if (FORMATS[row.file_ext]?.zip) {
      const inspected = inspectArchive(buffer, { install: FORMATS[row.file_ext].install });
      if (inspected.icon) {
        await renderIconCard(inspected.icon, name);
      } else {
        await renderPlaceholderCard(name, { kind: row.kind, title: row.title });
      }
    } else {
      await renderPlaceholderCard(name, { kind: row.kind, title: row.title });
    }

    redrawn += 1;
    if (redrawn % 20 === 0) console.log(`  …${redrawn}/${rows.length}`);
  } catch (error) {
    console.warn(`  ! ${row.id} (${row.title}) — ${error.message}`);
    skipped += 1;
  }
}

console.log(`  Done. ${redrawn} redrawn${skipped ? `, ${skipped} skipped` : ''}.`);
