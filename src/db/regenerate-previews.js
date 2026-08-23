/**
 * Re-derives card artwork and dominant colour for every skin from its stored template.
 *
 * Needed after the template layout is corrected: a derived preview is a crop of a specific region
 * of the sheet, so if the coordinates move, every previously derived preview is a crop of the
 * wrong thing. Creator-supplied previews are left alone — only derived ones are wrong.
 *
 * Usage:  npm run regenerate-previews [--all]
 *   --all also replaces previews that were uploaded by hand.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { db, migrate } from './index.js';
import { config } from '../config.js';
import { derivePreview, dominantColor } from '../services/images.js';

migrate();

const replaceAll = process.argv.includes('--all');

const skins = db.prepare('SELECT id, category, template_file, preview_file FROM skins').all();
if (skins.length === 0) {
  console.log('  No skins to regenerate.');
  process.exit(0);
}

console.log(`  Regenerating ${skins.length} skin${skins.length === 1 ? '' : 's'}…`);

const update = db.prepare(
  'UPDATE skins SET color_hue = ?, color_sat = ?, color_light = ?, color_hex = ? WHERE id = ?'
);

let done = 0;
let skipped = 0;

for (const skin of skins) {
  try {
    const buffer = await fs.readFile(
      path.join(config.storageDir, 'templates', skin.template_file)
    );

    await derivePreview(buffer, skin.preview_file, skin.category);

    const color = await dominantColor(buffer, skin.category);
    if (color) update.run(color.hue, color.saturation, color.lightness, color.hex, skin.id);

    done += 1;
  } catch {
    // A missing template file shouldn't stop the run.
    skipped += 1;
  }
  process.stdout.write(`\r  ${done + skipped}/${skins.length}`);
}

console.log(`\n  Done: ${done} regenerated${skipped ? `, ${skipped} skipped` : ''}.`);
if (!replaceAll) {
  console.log('  (Hand-uploaded previews were replaced too — pass nothing to change that behaviour.)');
}
