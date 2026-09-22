/**
 * Fills the picture bank فقاعات الكلمات and وصّل الحروف are played on, from
 * the rounds written in `scripts/picture-seed.txt`.
 *
 *   npm run seed-pictures -- --check     # reads the file and says what is wrong
 *   npm run seed-pictures -- --draw      # draws the pictures into the picture folder
 *   npm run seed-pictures                # saves the rounds that have a picture
 *   npm run seed-pictures -- --words     # and takes their words back from the file
 *
 * Each line is `source | العنوان | كلمة، كلمة، …`, and a line `@ تصنيف` files
 * everything under it in that category. The sources a line may name, and how a
 * drawing is fetched and stored, are in src/drawings.js.
 *
 * Drawing needs `sharp`, which the service does not: draw on a machine that has
 * it, copy the files over, and save the rounds there. A drawing's file name
 * comes from its source, so both steps agree on it without being told. Running it again
 * adds only the titles that are not in the bank yet, so the file can be grown a
 * few rounds at a time.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { letters, foldForPlay } from '../src/arabic.js';
import { buildPictureConnect } from '../src/connect.js';
import { config } from '../src/config.js';
import { db } from '../src/db/index.js';
import { drawOrPlain, emojiNames, fileFor, sourceOf } from '../src/drawings.js';
import { createBubblePictures, readRound } from '../src/bubble-pictures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(HERE, 'picture-seed.txt');

/** The rounds as written: `{ rounds, problems }`. */
export function readSeed(text) {
  const rounds = [];
  const problems = [];
  const seen = new Set();
  // `@ فواكه وخضار` puts every round under it in that category, until the next one.
  let category = '';
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    if (line.startsWith('@')) {
      category = line.slice(1).trim();
      return;
    }
    const at = `سطر ${index + 1}`;
    const [name, title, words] = line.split('|').map((part) => part.trim());
    if (!name || !title || !words) return problems.push(`${at}: السطر ثلاثة أجزاء مفصولة بـ |`);

    const list = words.split(/[،,]+/).map((word) => word.trim()).filter(Boolean);
    const { round, errors } = readRound({ title, category, words: list.join('\n'), imageFile: 'seed.png' });
    if (errors) return problems.push(`${at} «${title}»: ${errors.join(' ')}`);
    if (seen.has(title)) return problems.push(`${at}: «${title}» مكتوب مرتين`);
    seen.add(title);
    rounds.push({ name, ...round });
  });
  return { rounds, problems };
}

/** Whether a round's words can also make a وصّل الحروف board. */
const fitsConnect = (round) => Boolean(buildPictureConnect(round, round.title.length + round.words.length));

const check = process.argv.includes('--check');
/** `--words` rewrites the words of rounds already in the bank from the file. */
const rewording = process.argv.includes('--words');
const { rounds, problems } = readSeed(await fs.readFile(SEED, 'utf8'));
problems.forEach((problem) => console.error(`✗ ${problem}`));
console.log(`${rounds.length} rounds read, ${problems.length} problems`);

const thin = rounds.filter((round) => !fitsConnect(round));
if (thin.length) {
  console.log(`${thin.length} rounds fill no وصّل الحروف board (they still play in فقاعات):`);
  thin.forEach((round) => console.log(`  ${round.title}: ${round.words.join('، ')}`));
}

const names = await emojiNames();
/** What a round's picture is fetched by: a drawing's id, or an emoji's codepoints. */
const drawingOf = (round) => sourceOf(round.name, names);
const unknown = rounds.filter((round) => !drawingOf(round));
unknown.forEach((round) => console.error(`✗ «${round.title}»: no emoji named «${round.name}»`));

if (check) process.exit(problems.length || unknown.length ? 1 : 0);
if (problems.length) {
  console.error('Nothing was saved: fix the lines above first.');
  process.exit(1);
}

await fs.mkdir(config.imagesDir, { recursive: true });

if (process.argv.includes('--draw')) {
  let drawn = 0;
  let failed = 0;
  for (const round of rounds) {
    const code = drawingOf(round);
    const file = path.join(config.imagesDir, fileFor(code));
    if (await fs.access(file).then(() => true, () => false)) continue;
    const png = await drawOrPlain(code);
    if (!png) {
      console.error(`✗ «${round.title}»: no drawing for ${code}`);
      failed++;
      continue;
    }
    await fs.writeFile(file, png);
    drawn++;
    if (drawn % 50 === 0) console.log(`  … ${drawn} pictures`);
  }
  console.log(`drew ${drawn} pictures into ${config.imagesDir}, ${failed} without a drawing`);
  process.exit(failed ? 1 : 0);
}

const pictures = createBubblePictures(db, { publicUrl: config.publicUrl });
const have = new Map(pictures.all().map((round) => [round.title, round]));
let added = 0;
let sorted = 0;
let missing = 0;

for (const round of rounds) {
  const already = have.get(round.title);
  if (already) {
    // A round already in the bank keeps its words — they may have been edited
    // in the panel — but follows the file for its category and its picture, so
    // changing a source here swaps the drawing on the next run. `--words` also
    // takes the words back from the file, for when they are rewritten here.
    const wanted = fileFor(drawingOf(round));
    const drawn = await fs.access(path.join(config.imagesDir, wanted)).then(() => true, () => false);
    const file = drawn ? wanted : already.imageFile;
    const words = rewording ? round.words : already.words;
    if ((already.category ?? '') !== round.category || already.imageFile !== file
        || words.join('\n') !== already.words.join('\n')) {
      pictures.save({
        title: already.title,
        category: round.category,
        words: words.join('\n'),
        imageFile: file,
        zoom: already.zoom,
        focusX: already.focusX,
        focusY: already.focusY,
      }, already.id);
      sorted++;
    }
    continue;
  }
  const file = fileFor(drawingOf(round));
  if (!await fs.access(path.join(config.imagesDir, file)).then(() => true, () => false)) {
    console.error(`✗ «${round.title}»: no picture drawn yet (run --draw)`);
    missing++;
    continue;
  }

  const saved = pictures.save({
    title: round.title,
    category: round.category,
    words: round.words.join('\n'),
    imageFile: file,
    zoom: 1,
    focusX: 0.5,
    focusY: 0.5,
  });
  if (saved.errors) {
    console.error(`✗ «${round.title}»: ${saved.errors.join(' ')}`);
    missing++;
    continue;
  }
  pictures.setPublished(saved.id, true);
  added++;
  if (added % 50 === 0) console.log(`  … ${added} rounds`);
}

const counts = pictures.counts();
console.log(`added ${added}, brought ${sorted} up to date, skipped ${missing};`
  + ` the bank now holds ${counts.total} rounds, ${counts.published} published`);
for (const group of pictures.categories()) {
  console.log(`  ${group.name || '(بلا تصنيف)'}: ${group.total}`);
}
