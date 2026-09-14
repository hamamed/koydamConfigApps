#!/usr/bin/env node
/**
 * Renders a short vertical showcase clip for each outfit from its official
 * Fortnite-API artwork — the render over a rarity-coloured background, with
 * the name, rarity and set.
 *
 * By default only outfits that have no upstream YouTube showcase get a clip;
 * the others already have a video. Clips are named by the exact cosmetic id,
 * so the API can find them without a lookup table.
 *
 *   node scripts/showcase-clips.js --out ./storage/showcase
 *   node scripts/showcase-clips.js --out /tmp/clips --ids Character_AgentSherbert
 *   node scripts/showcase-clips.js --out ./storage/showcase --all --concurrency 4
 *
 * Needs an ffmpeg built with libfreetype (drawtext). Homebrew's plain `ffmpeg`
 * is not; `ffmpeg-full` is, and is the default below. An existing clip is left
 * alone unless --force is given, so an interrupted run resumes where it stopped.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const UPSTREAM = 'https://fortnite-api.com/v2/cosmetics/br';
const ARTWORK_HOST = 'fortnite-api.com';
const FETCH_TIMEOUT_MS = 30_000;
const MAX_ARTWORK_BYTES = 10 * 1024 * 1024;

// Upstream data becomes file names and filter arguments. Anything outside these
// shapes is refused rather than escaped: a clip named `../../x` must not exist.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const HEX_COLOR = /^[0-9a-fA-F]{6}$/;
const WIDTH = 720;
const HEIGHT = 1280;
const FPS = 30;
const DURATION = 6;
const FADE_OUT = 0.4;
// Wider than the frame on purpose: the featured renders carry a lot of empty
// margin, and at frame width the character filled barely a third of it.
const RENDER_WIDTH = 880;
const RENDER_LIFT = 190; // px above centre, so the feet stay clear of the caption panel
const MAX_NAME_SIZE = 84;
const NAME_SIZE_BUDGET = 1280; // ≈ usable width ÷ average glyph width ratio

const DEFAULTS = {
  out: './storage/showcase',
  ffmpeg: '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg',
  titleFont: '/System/Library/Fonts/Supplemental/Impact.ttf',
  bodyFont: '/System/Library/Fonts/Supplemental/DIN Alternate Bold.ttf',
  concurrency: 3,
};

/** Light and dark stop for each rarity, where upstream gives no series colours. */
const RARITY_COLORS = {
  common: ['8a8d91', '2b2d31'],
  uncommon: ['69bb1e', '1b4a0c'],
  rare: ['2cc3fc', '0b3d7a'],
  epic: ['c359ff', '3b0f6b'],
  legendary: ['ea8d23', '6b2a08'],
  mythic: ['f8e14c', '7a5a06'],
  exotic: ['76d6e3', '145a66'],
};
const FALLBACK_COLORS = RARITY_COLORS.common;

function parseArgs(argv) {
  const options = { ...DEFAULTS, all: false, force: false, ids: null, limit: Infinity };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      i += 1;
      return next;
    };
    if (flag === '--out') options.out = value();
    else if (flag === '--ffmpeg') options.ffmpeg = value();
    else if (flag === '--title-font') options.titleFont = value();
    else if (flag === '--body-font') options.bodyFont = value();
    else if (flag === '--ids') options.ids = new Set(value().split(',').map((s) => s.trim()).filter(Boolean));
    else if (flag === '--limit') options.limit = positiveInt(value(), flag);
    else if (flag === '--concurrency') options.concurrency = positiveInt(value(), flag);
    else if (flag === '--all') options.all = true;
    else if (flag === '--force') options.force = true;
    else throw new Error(`Unknown option ${flag}`);
  }
  return options;
}

function positiveInt(raw, flag) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`);
  return n;
}

async function fetchOutfits() {
  const response = await fetch(UPSTREAM, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Fortnite-API answered ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body?.data)) throw new Error('Fortnite-API returned no cosmetics list');
  return body.data.filter((item) => item?.type?.value === 'outfit');
}

/** The artwork to feature: the large render where there is one, from upstream's own host only. */
function artworkUrl(item) {
  const raw = item.images?.featured || item.images?.icon;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname === ARTWORK_HOST ? url.href : null;
  } catch {
    return null;
  }
}

function selectOutfits(outfits, options) {
  return outfits
    .filter((item) => SAFE_ID.test(String(item.id ?? '')))
    .filter((item) => (options.ids ? options.ids.has(item.id) : true))
    .filter((item) => options.ids || options.all || !item.showcaseVideo)
    .filter((item) => artworkUrl(item))
    .slice(0, options.limit);
}

/** Series items carry their own palette; everything else goes by rarity. */
function colorsFor(item) {
  const series = item.series?.colors;
  if (Array.isArray(series) && series.length >= 4) {
    const [light, dark] = [series[1], series[3]].map((color) => String(color).slice(0, 6));
    if (HEX_COLOR.test(light) && HEX_COLOR.test(dark)) return [light, dark];
  }
  return RARITY_COLORS[item.rarity?.value] ?? FALLBACK_COLORS;
}

/** drawtext reads option values with ':' and '\'' as syntax. */
function filterPath(p) {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function textLayer({ file, font, size, y, color = 'white', box = null, delay }) {
  const parts = [
    `textfile='${filterPath(file)}'`,
    `fontfile='${filterPath(font)}'`,
    'expansion=none',
    `fontsize=${size}`,
    `fontcolor=${color}`,
    'x=(w-text_w)/2',
    `y=${y}`,
    'borderw=3',
    'bordercolor=black@0.55',
    `alpha='min(1,max(0,(t-${delay})/0.4))'`,
  ];
  if (box) parts.push('box=1', `boxcolor=0x${box}@0.95`, 'boxborderw=14');
  return `drawtext=${parts.join(':')}`;
}

function buildFilter(item, texts, options) {
  const [light, dark] = colorsFor(item);
  const nameSize = Math.min(MAX_NAME_SIZE, Math.floor(NAME_SIZE_BUDGET / Math.max(1, texts.name.length)));
  const zoom = `(1+0.06*t/${DURATION})`;

  const background =
    `gradients=s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${DURATION}:type=radial:speed=0:nb_colors=2` +
    `:c0=0x${light}:c1=0x${dark}:x0=${WIDTH / 2}:y0=${HEIGHT * 0.4}:x1=${WIDTH / 2}:y1=${HEIGHT * 1.15}[bg]`;
  // A slow push-in, re-evaluated every frame, keeps a still render from reading as a slide.
  const artwork = `[0:v]format=rgba,scale=w='trunc(${RENDER_WIDTH}*${zoom}/2)*2':h=-2:eval=frame[art]`;

  const stage = [
    `[bg][art]overlay=x='(W-w)/2':y='(H-h)/2-${RENDER_LIFT}+50*max(0,1-t/0.6)':format=auto`,
    `drawbox=x=0:y=${HEIGHT - 380}:w=iw:h=380:color=black@0.35:t=fill`,
    textLayer({ file: texts.nameFile, font: options.titleFont, size: nameSize, y: HEIGHT - 340, delay: 0.3 }),
    textLayer({ file: texts.rarityFile, font: options.bodyFont, size: 32, y: HEIGHT - 225, box: light, delay: 0.6 }),
  ];
  if (texts.setFile) {
    stage.push(textLayer({ file: texts.setFile, font: options.bodyFont, size: 30, y: HEIGHT - 150, color: 'white@0.85', delay: 0.9 }));
  }
  stage.push(`fade=t=in:d=0.3,fade=t=out:st=${DURATION - FADE_OUT}:d=${FADE_OUT},format=yuv420p[out]`);

  return [background, artwork, stage.join(',')].join(';');
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`))));
  });
}

async function download(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`artwork ${response.status} for ${url}`);
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_ARTWORK_BYTES) throw new Error(`artwork is ${declared} bytes, over the cap, for ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ARTWORK_BYTES) throw new Error(`artwork is ${bytes.length} bytes, over the cap, for ${url}`);
  await writeFile(destination, bytes);
}

async function renderClip(item, options) {
  const target = path.join(options.out, `${item.id}.mp4`);
  if (!options.force && existsSync(target)) return 'skipped';

  const work = await mkdtemp(path.join(os.tmpdir(), 'showcase-'));
  try {
    const art = path.join(work, 'art.png');
    await download(artworkUrl(item), art);

    const texts = {
      name: String(item.name ?? item.id).toUpperCase(),
      nameFile: path.join(work, 'name.txt'),
      rarityFile: path.join(work, 'rarity.txt'),
      setFile: item.set?.value ? path.join(work, 'set.txt') : null,
    };
    await writeFile(texts.nameFile, texts.name);
    await writeFile(texts.rarityFile, String(item.rarity?.displayValue ?? 'Outfit').toUpperCase());
    if (texts.setFile) await writeFile(texts.setFile, `${item.set.value} Set`);

    // Rendered beside the target and renamed, so a killed run never leaves a
    // truncated file that a resume would then skip as done.
    const partial = path.join(work, 'clip.mp4');
    await run(options.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-loop', '1', '-t', String(DURATION), '-i', art,
      '-filter_complex', buildFilter(item, texts, options),
      '-map', '[out]', '-r', String(FPS),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '26', '-profile:v', 'high',
      '-movflags', '+faststart', '-an', partial,
    ]);
    await rename(partial, target).catch(async (error) => {
      if (error.code !== 'EXDEV') throw error;
      await run('cp', [partial, target]);
    });
    return 'rendered';
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  for (const file of [options.ffmpeg, options.titleFont, options.bodyFont]) {
    if (!existsSync(file)) throw new Error(`Not found: ${file}`);
  }
  await mkdir(options.out, { recursive: true });

  const queue = selectOutfits(await fetchOutfits(), options);
  const counts = { rendered: 0, skipped: 0, failed: 0 };
  const failures = [];
  let next = 0;
  let done = 0;

  const worker = async () => {
    while (next < queue.length) {
      const item = queue[next];
      next += 1;
      try {
        counts[await renderClip(item, options)] += 1;
      } catch (error) {
        counts.failed += 1;
        failures.push(`${item.id}: ${error.message}`);
      }
      done += 1;
      if (done % 25 === 0 || done === queue.length) {
        process.stdout.write(`${done}/${queue.length} rendered=${counts.rendered} skipped=${counts.skipped} failed=${counts.failed}\n`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, queue.length) }, worker));

  for (const line of failures) process.stderr.write(`FAILED ${line}\n`);
  process.exitCode = counts.failed > 0 ? 1 : 0;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
