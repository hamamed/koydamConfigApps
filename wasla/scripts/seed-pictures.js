/**
 * Fills the picture bank فقاعات الكلمات and وصّل الحروف are played on, from
 * the rounds written in `scripts/picture-seed.txt`.
 *
 *   npm run seed-pictures -- --check     # reads the file and says what is wrong
 *   npm run seed-pictures -- --draw      # draws the pictures into the picture folder
 *   npm run seed-pictures                # saves the rounds that have a picture
 *
 * Each line is `source | العنوان | كلمة، كلمة، …`. The source is the English
 * name of an emoji, whose Twemoji drawing is used (CC BY 4.0,
 * https://github.com/jdecked/twemoji), or `openclipart:<id>` for the things
 * emoji has no drawing of — الرمان، البامية، الجوافة — from Openclipart, which
 * is public domain (CC0, https://openclipart.org).
 *
 * Either way the drawing is fetched as SVG and drawn at 512 px on nothing: it
 * keeps its own shape, the card it is shown on provides the background, and it
 * is drawn inside a margin so the rounded frame the app draws around a picture
 * never cuts a corner of it.
 *
 * Drawing needs `sharp`, which the service does not: draw on a machine that has
 * it, copy the files over, and save the rounds there. A round's file name comes
 * from the emoji, so both steps agree on it without being told. Running it again
 * adds only the titles that are not in the bank yet, so the file can be grown a
 * few rounds at a time.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { letters, foldForPlay } from '../src/arabic.js';
import { buildConnect, connectPool } from '../src/connect.js';
import { config } from '../src/config.js';
import { db } from '../src/db/index.js';
import { createBubblePictures, readRound } from '../src/bubble-pictures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(HERE, 'picture-seed.txt');
const NAMES = 'https://unicode.org/Public/emoji/15.1/emoji-test.txt';
const TWEMOJI = (code) => `https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/svg/${code}.svg`;
const OPENCLIPART = (id) => `https://openclipart.org/download/${id}/`;
const OPENCLIPART_PAGE = (id) => `https://openclipart.org/detail/${id}/`;
/** A source that names a drawing rather than an emoji. */
const CLIPART = /^openclipart:(\d+)$/;
const SIDE = 512;
/** The margin the drawing keeps on every side, so no edge of it is clipped. */
const MARGIN = 52;

/** `{ name: codepoints }` for every emoji Unicode lists, by its English name. */
async function emojiNames() {
  const text = await (await fetch(NAMES)).text();
  const names = new Map();
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.includes('; fully-qualified')) continue;
    const [codes, rest] = line.split(';');
    const name = rest.match(/#\s+\S+\s+E\d+\.\d+\s+(.+?)\s*$/)?.[1];
    if (name) names.set(name.toLowerCase(), codes.trim().split(/\s+/).map((c) => c.toLowerCase()).join('-'));
  }
  return names;
}

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
    rounds.push({ name: name.toLowerCase(), ...round });
  });
  return { rounds, problems };
}

/** Whether a round's words can also fill a وصّل الحروف board. */
const fitsConnect = (round) => Boolean(buildConnect(
  connectPool(round.words.map((word, id) => ({ id, answer: word, clue: round.title }))),
  round.title.length + round.words.length,
));

/** The name a round's picture is stored under: its source, and nothing else. */
const fileFor = (code) => `${crypto.createHash('md5').update(code).digest('hex').slice(0, 24)}.png`;

/**
 * The drawing's file. Openclipart's `/download/<id>/` sometimes answers 500
 * rather than redirecting, so its page is read for the file's own address.
 */
async function fetchDrawing(source) {
  const clipart = source.match(CLIPART);
  if (!clipart) return fetch(TWEMOJI(source), { headers: { 'User-Agent': 'wasla-seed' } });

  const direct = await fetch(OPENCLIPART(clipart[1]), { headers: { 'User-Agent': 'wasla-seed' } });
  if (direct.ok) return direct;
  const page = await fetch(OPENCLIPART_PAGE(clipart[1]), { headers: { 'User-Agent': 'wasla-seed' } });
  if (!page.ok) return direct;
  const file = (await page.text()).match(new RegExp(`/download/${clipart[1]}/[^"']+\\.svg`))?.[0];
  return file ? fetch(`https://openclipart.org${file}`, { headers: { 'User-Agent': 'wasla-seed' } }) : direct;
}

async function draw(source) {
  const svg = await fetchDrawing(source);
  if (!svg.ok) return null;
  const { default: sharp } = await import('sharp');
  return sharp(Buffer.from(await svg.arrayBuffer()), { density: 600 })
    .resize(SIDE - MARGIN * 2, SIDE - MARGIN * 2, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .extend({
      top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN,
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    })
    .png()
    .toBuffer();
}

const check = process.argv.includes('--check');
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
const sourceOf = (round) => (CLIPART.test(round.name) ? round.name : names.get(round.name));
const unknown = rounds.filter((round) => !sourceOf(round));
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
    const code = sourceOf(round);
    const file = path.join(config.imagesDir, fileFor(code));
    if (await fs.access(file).then(() => true, () => false)) continue;
    // Twemoji leaves the variation selector out of the files it ships.
    const png = await draw(code) ?? await draw(code.replace(/-fe0f/g, ''));
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
    // changing a source here swaps the drawing on the next run.
    const wanted = fileFor(sourceOf(round));
    const drawn = await fs.access(path.join(config.imagesDir, wanted)).then(() => true, () => false);
    const file = drawn ? wanted : already.imageFile;
    if ((already.category ?? '') !== round.category || already.imageFile !== file) {
      pictures.save({
        title: already.title,
        category: round.category,
        words: already.words.join('\n'),
        imageFile: file,
        zoom: already.zoom,
        focusX: already.focusX,
        focusY: already.focusY,
      }, already.id);
      sorted++;
    }
    continue;
  }
  const file = fileFor(sourceOf(round));
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
