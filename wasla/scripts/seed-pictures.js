/**
 * Fills the picture bank فقاعات الكلمات and وصّل الحروف are played on, from
 * the rounds written in `scripts/picture-seed.txt`.
 *
 *   npm run seed-pictures -- --check     # reads the file and says what is wrong
 *   npm run seed-pictures -- --draw      # draws the pictures into the picture folder
 *   npm run seed-pictures                # saves the rounds that have a picture
 *
 * Each line is `emoji name | العنوان | كلمة، كلمة، …`. The picture is the
 * Twemoji drawing of that emoji (CC BY 4.0, https://github.com/jdecked/twemoji),
 * fetched as SVG and drawn at 512 px onto white.
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
const SIDE = 512;

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
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const at = `سطر ${index + 1}`;
    const [name, title, words] = line.split('|').map((part) => part.trim());
    if (!name || !title || !words) return problems.push(`${at}: السطر ثلاثة أجزاء مفصولة بـ |`);

    const list = words.split(/[،,]+/).map((word) => word.trim()).filter(Boolean);
    const { round, errors } = readRound({ title, words: list.join('\n'), imageFile: 'seed.png' });
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

/** The name a round's picture is stored under: the emoji, and nothing else. */
const fileFor = (code) => `${crypto.createHash('md5').update(code).digest('hex').slice(0, 24)}.png`;

async function draw(code) {
  const svg = await fetch(TWEMOJI(code));
  if (!svg.ok) return null;
  const { default: sharp } = await import('sharp');
  return sharp(Buffer.from(await svg.arrayBuffer()), { density: 600 })
    .resize(SIDE, SIDE, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .flatten({ background: '#FFFFFF' })
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
const unknown = rounds.filter((round) => !names.has(round.name));
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
    const code = names.get(round.name);
    const file = path.join(config.imagesDir, fileFor(code));
    if (await fs.access(file).then(() => true, () => false)) continue;
    // Twemoji leaves the variation selector out of the files it ships.
    const png = await draw(code) ?? await draw(code.replace(/-fe0f/g, ''));
    if (!png) {
      console.error(`✗ «${round.title}»: twemoji has no drawing for ${code}`);
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
const have = new Set(pictures.all().map((round) => round.title));
let added = 0;
let missing = 0;

for (const round of rounds) {
  if (have.has(round.title)) continue;
  const file = fileFor(names.get(round.name));
  if (!await fs.access(path.join(config.imagesDir, file)).then(() => true, () => false)) {
    console.error(`✗ «${round.title}»: no picture drawn yet (run --draw)`);
    missing++;
    continue;
  }

  const saved = pictures.save({
    title: round.title,
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
console.log(`added ${added}, skipped ${missing}; the bank now holds ${counts.total} rounds, ${counts.published} published`);
