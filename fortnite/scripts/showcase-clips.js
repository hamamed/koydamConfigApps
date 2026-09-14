#!/usr/bin/env node
/**
 * Renders a short silent clip for each outfit from its official artwork: what
 * sits inside the app's detail box — the tier backdrop with the skin on it —
 * in a slow zoom that loops like a GIF. No frame and no text: the app and the
 * panel draw their own box and name around it.
 *
 * By default only outfits that have no upstream YouTube showcase get one; the
 * others are cut from that showcase by scripts/showcase-youtube.js. Clips are
 * named by the exact cosmetic id, so the API finds them without a lookup table.
 *
 *   node scripts/showcase-clips.js --out ./storage/showcase
 *   node scripts/showcase-clips.js --out /tmp/clips --ids Character_AgentSherbert --force
 *   node scripts/showcase-clips.js --out ./storage/showcase --all --concurrency 4
 *
 * Needs ffmpeg and Google Chrome: headless Chrome draws the two still layers
 * (scripts/showcase/page.js), ffmpeg animates them. An existing clip is left
 * alone unless --force, so an interrupted run resumes where it stopped.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { TIERS, resolveTier } from '../src/tiers.js';
import { launchRenderer } from './showcase/chrome.js';
import { renderedClipArgs } from './showcase/compose.js';
import { pageHtml, tierCss } from './showcase/page.js';

const UPSTREAM = 'https://fortnite-api.com/v2/cosmetics/br';
const ARTWORK_HOST = 'fortnite-api.com';
const FETCH_TIMEOUT_MS = 30_000;
const MAX_ARTWORK_BYTES = 10 * 1024 * 1024;

// Upstream ids become file names. Anything outside this shape is refused
// rather than escaped: a clip named `../../x` must not exist.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

const DEFAULTS = {
  out: './storage/showcase',
  ffmpeg: '/opt/homebrew/bin/ffmpeg',
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  concurrency: 3,
};

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
    else if (flag === '--chrome') options.chrome = value();
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

/** The artwork the app's detail box shows — featured first — from upstream's own host only. */
function artworkUrl(item) {
  const raw = item.images?.featured || item.images?.icon || item.images?.smallIcon;
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
    // A small icon alone is too little to fill the box; those are placeholders.
    .filter((item) => item.images?.featured || item.images?.icon)
    .filter((item) => artworkUrl(item))
    .slice(0, options.limit);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited ${code}: ${stderr.trim()}`))));
  });
}

/**
 * The artwork as a data URL. Handed to Chrome inline rather than as a file: a
 * page may read the pixels of a data URL, which the trim needs, while a file://
 * image is cross-origin to the page and its pixels are locked.
 */
async function downloadArtwork(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`artwork ${response.status} for ${url}`);
  const type = String(response.headers.get('content-type') ?? '').split(';')[0].trim();
  if (!/^image\/(png|webp|jpeg)$/.test(type)) throw new Error(`artwork is ${type || 'untyped'}, not an image, for ${url}`);
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_ARTWORK_BYTES) throw new Error(`artwork is ${declared} bytes, over the cap, for ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ARTWORK_BYTES) throw new Error(`artwork is ${bytes.length} bytes, over the cap, for ${url}`);
  return `data:${type};base64,${bytes.toString('base64')}`;
}

/** Puts a finished clip in place without ever exposing a partial one. */
async function moveInto(source, target) {
  try {
    await rename(source, target);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    const staging = `${target}.partial`;
    await copyFile(source, staging);
    await rename(staging, target);
  }
}

async function renderClip(item, options, renderer) {
  const target = path.join(options.out, `${item.id}.mp4`);
  if (!options.force && existsSync(target)) return 'skipped';

  const work = await mkdtemp(path.join(os.tmpdir(), 'showcase-'));
  try {
    const tier = resolveTier(item.rarity?.value, item.series?.value);
    const { layers, art } = await renderer.render({
      css: tierCss(TIERS[tier]),
      artUrl: await downloadArtwork(artworkUrl(item)),
    });

    const files = {};
    for (const [name, buffer] of Object.entries(layers)) {
      files[name] = path.join(work, `${name}.png`);
      await writeFile(files[name], buffer);
    }

    const partial = path.join(work, 'clip.mp4');
    await run(options.ffmpeg, renderedClipArgs(files, art, partial));
    await moveInto(partial, target);
    return 'rendered';
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  for (const file of [options.ffmpeg, options.chrome]) {
    if (!existsSync(file)) throw new Error(`Not found: ${file}`);
  }
  await mkdir(options.out, { recursive: true });

  const queue = selectOutfits(await fetchOutfits(), options);
  const renderer = await launchRenderer({ chrome: options.chrome, html: pageHtml() });

  const counts = { rendered: 0, skipped: 0, failed: 0 };
  const failures = [];
  let next = 0;
  let done = 0;

  const worker = async () => {
    while (next < queue.length) {
      const item = queue[next];
      next += 1;
      try {
        counts[await renderClip(item, options, renderer)] += 1;
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

  try {
    await Promise.all(Array.from({ length: Math.min(options.concurrency, queue.length) }, worker));
  } finally {
    await renderer.close();
  }

  for (const line of failures) process.stderr.write(`FAILED ${line}\n`);
  process.exitCode = counts.failed > 0 ? 1 : 0;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
