/**
 * Samples the dominant colour for skins uploaded before colour extraction existed.
 *
 * Idempotent — only touches rows where `color_hex` is still null, so it's safe to re-run after
 * a partial pass or a failed image.
 *
 * Usage:  node src/db/backfill-colors.js
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { db, migrate } from './index.js';
import { config } from '../config.js';
import { dominantColor } from '../services/images.js';

migrate();

const pending = db
  .prepare('SELECT id, category, template_file FROM skins WHERE color_hex IS NULL')
  .all();

if (pending.length === 0) {
  console.log('  Every skin already has a colour.');
  process.exit(0);
}

console.log(`  Sampling ${pending.length} skins…`);

const update = db.prepare(
  'UPDATE skins SET color_hue = ?, color_sat = ?, color_light = ?, color_hex = ? WHERE id = ?'
);

let done = 0;
let skipped = 0;

for (const skin of pending) {
  try {
    const buffer = await fs.readFile(path.join(config.storageDir, 'templates', skin.template_file));
    const color = await dominantColor(buffer, skin.category);
    if (!color) {
      skipped += 1;
      continue;
    }
    update.run(color.hue, color.saturation, color.lightness, color.hex, skin.id);
    done += 1;
  } catch {
    // A missing file shouldn't stop the run — report it at the end instead.
    skipped += 1;
  }
  process.stdout.write(`\r  ${done + skipped}/${pending.length}`);
}

console.log(`\n  Done: ${done} updated${skipped ? `, ${skipped} skipped` : ''}.`);
