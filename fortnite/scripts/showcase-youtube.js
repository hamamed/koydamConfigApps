#!/usr/bin/env node
/**
 * Cuts a silent clip from each outfit's YouTube showcase: the footage of the
 * skin, cropped to the 3:4 shape of the app's detail box and the panel card,
 * looping like a GIF. No frame and no text are added — the app and the panel
 * draw their own box and name — and the channel's own watermark stays in the
 * footage.
 *
 * Only channels listed in scripts/showcase/youtube.js are used — the ones that
 * gave permission. yt-dlp is told to download nothing else, and the channel it
 * reports is checked again before the video is used.
 *
 *   node scripts/showcase-youtube.js --out ./storage/showcase
 *   node scripts/showcase-youtube.js --out /tmp/clips --ids CID_349_Athena_Commando_M_Banana --force
 *   node scripts/showcase-youtube.js --out ./storage/showcase --video-map matches.json --ids ... --force
 *
 * --video-map takes a JSON object of cosmetic id → YouTube id, for outfits
 * upstream links no showcase for but a permitted channel has one — found by
 * matching his upload titles to outfit names. The channel check still applies.
 *
 * From each video it takes the part clipTiming() chooses (after the in-game
 * info popup), finds where the skin is by what moves — the menus around it are
 * still — and crops a 3:4 window above the channel's bottom banner. Needs
 * yt-dlp, ffmpeg and ffprobe. Resumable: an existing clip is skipped unless
 * --force. If YouTube starts refusing downloads the run stops, so it can be
 * resumed later rather than failing every remaining video.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CLIP_FRAME, footageClipArgs } from './showcase/compose.js';
import { writeSource } from './showcase/source.js';
import {
  PERMITTED_CHANNELS, applyVideoMap, clipTiming, cropWindow, fitCrop, isInside, isPermittedChannel, motionCenter,
  parseMotionBox,
} from './showcase/youtube.js';

const UPSTREAM = 'https://fortnite-api.com/v2/cosmetics/br';
const FETCH_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 5 * 60_000;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** The channel's "Support a Creator Code" banner fills the bottom 75 of 1080 rows. */
const USABLE_HEIGHT_SHARE = 1005 / 1080;

/** YouTube's answers when it wants a batch to stop. Every later download would fail the same way. */
const BLOCKED = /not a bot|HTTP Error 429|Too Many Requests|confirm your age|Sign in to confirm/i;

const DEFAULTS = {
  out: './storage/showcase',
  ffmpeg: '/opt/homebrew/bin/ffmpeg',
  ffprobe: '/opt/homebrew/bin/ffprobe',
  ytDlp: path.join(os.homedir(), '.local/bin/yt-dlp'),
  concurrency: 3,
};

function parseArgs(argv) {
  const options = { ...DEFAULTS, force: false, ids: null, limit: Infinity, videoMap: null, type: 'outfit' };
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
    else if (flag === '--ffprobe') options.ffprobe = value();
    else if (flag === '--yt-dlp') options.ytDlp = value();
    else if (flag === '--video-map') options.videoMap = value();
    else if (flag === '--type') options.type = clipType(value());
    else if (flag === '--ids') options.ids = new Set(value().split(',').map((s) => s.trim()).filter(Boolean));
    else if (flag === '--limit') options.limit = positiveInt(value(), flag);
    else if (flag === '--concurrency') options.concurrency = positiveInt(value(), flag);
    else if (flag === '--force') options.force = true;
    else throw new Error(`Unknown option ${flag}`);
  }
  return options;
}

/** Cosmetic types a clip can be cut for: the ones whose showcases show the item moving. */
const CLIP_TYPES = new Set(['outfit', 'emote']);

function clipType(raw) {
  if (!CLIP_TYPES.has(raw)) throw new Error(`--type must be one of: ${[...CLIP_TYPES].join(', ')}`);
  return raw;
}

function positiveInt(raw, flag) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`);
  return n;
}

async function fetchCosmetics(type) {
  const response = await fetch(UPSTREAM, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Fortnite-API answered ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body?.data)) throw new Error('Fortnite-API returned no cosmetics list');
  return body.data.filter((item) => item?.type?.value === type);
}

/** The --video-map file: a plain JSON object of cosmetic id → YouTube id, or an error. */
async function readVideoMap(file) {
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} must be a JSON object of cosmetic id to YouTube id`);
  }
  return parsed;
}

function selectOutfits(outfits, options) {
  return outfits
    .filter((item) => SAFE_ID.test(String(item.id ?? '')))
    .filter((item) => YOUTUBE_ID.test(String(item.showcaseVideo ?? '')))
    .filter((item) => (options.ids ? options.ids.has(item.id) : true))
    .slice(0, options.limit);
}

/** Runs a command to completion and hands back what it printed; rejects with its stderr on failure. */
function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), COMMAND_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-20_000); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(command)} ${signal ? `killed (${signal})` : `exited ${code}`}: ${stderr.trim().slice(-600)}`));
    });
  });
}

/**
 * Downloads the showcase if, and only if, it is from a permitted channel.
 * @returns {Promise<{ file: string, channel: string } | null>} null when refused
 */
async function download(item, work, options) {
  const filters = PERMITTED_CHANNELS.flatMap((channel) => ['--match-filters', `channel = '${channel.replace(/'/g, "\\'")}'`]);
  const { stdout } = await capture(options.ytDlp, [
    '--no-playlist', '--no-warnings', '--no-progress', '--no-simulate',
    ...filters,
    '-f', 'bv*[height<=1080][ext=mp4]/bv*[height<=1080]/b[height<=1080]',
    '--sleep-interval', '2', '--max-sleep-interval', '6', '--retries', '3',
    '-o', path.join(work, 'source.%(ext)s'),
    '--print', 'after_move:%(channel)s\t%(filepath)s',
    `https://www.youtube.com/watch?v=${item.showcaseVideo}`,
  ]);

  const line = stdout.split('\n').find((l) => l.includes('\t'));
  if (!line) return null;
  const [channel, file] = line.split('\t');
  if (!isPermittedChannel(channel) || !file || !isInside(file, work) || !existsSync(file)) return null;
  return { file, channel };
}

/** Frame size and length of a downloaded video. */
async function probe(file, options) {
  const { stdout } = await capture(options.ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file,
  ]);
  const info = JSON.parse(stdout);
  const width = Number(info.streams?.[0]?.width);
  const height = Number(info.streams?.[0]?.height);
  if (!width || !height) throw new Error('could not read the video size');
  return { width, height, duration: Number(info.format?.duration) };
}

/** The centre of whatever moves above the banner during the part of the video that is used. */
async function skinCentre(file, usableHeight, timing, options) {
  const { stderr } = await capture(options.ffmpeg, [
    '-hide_banner', '-ss', String(timing.start), '-t', String(timing.duration), '-i', file,
    '-vf', `crop=iw:${usableHeight}:0:0,tblend=all_mode=difference,format=gray,cropdetect=limit=0.12:round=2:reset=0`,
    '-f', 'null', '-',
  ]);
  return motionCenter(parseMotionBox(stderr));
}

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

/** @returns {Promise<'rendered' | 'skipped' | 'refused' | 'short'>} */
async function cutClip(item, options) {
  const target = path.join(options.out, `${item.id}.mp4`);
  if (!options.force && existsSync(target)) return 'skipped';

  const work = await mkdtemp(path.join(os.tmpdir(), 'showcase-yt-'));
  try {
    const source = await download(item, work, options);
    if (!source) return 'refused';

    const video = await probe(source.file, options);
    const timing = clipTiming(video.duration);
    if (!timing) return 'short';

    const usableHeight = Math.floor((video.height * USABLE_HEIGHT_SHARE) / 2) * 2;
    const centre = await skinCentre(source.file, usableHeight, timing, options);
    const crop = fitCrop(CLIP_FRAME, usableHeight, video.width);
    const window = { ...crop, x: cropWindow(centre, video.width, crop.width), y: 0 };

    const partial = path.join(work, 'clip.mp4');
    await capture(options.ffmpeg, footageClipArgs(source.file, window, timing, partial));
    await moveInto(partial, target);
    await writeSource(options.out, item.id, { source: 'youtube', channel: source.channel, video: item.showcaseVideo });
    return 'rendered';
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  for (const file of [options.ffmpeg, options.ffprobe, options.ytDlp]) {
    if (!existsSync(file)) throw new Error(`Not found: ${file}`);
  }
  await mkdir(options.out, { recursive: true });
  const videoMap = options.videoMap ? await readVideoMap(options.videoMap) : {};
  const queue = selectOutfits(applyVideoMap(await fetchCosmetics(options.type), videoMap), options);

  const counts = { rendered: 0, skipped: 0, refused: 0, short: 0, failed: 0 };
  const failures = [];
  let next = 0;
  let done = 0;
  let blocked = null;

  const worker = async () => {
    while (next < queue.length && !blocked) {
      const item = queue[next];
      next += 1;
      try {
        counts[await cutClip(item, options)] += 1;
      } catch (error) {
        counts.failed += 1;
        failures.push(`${item.id}: ${error.message}`);
        if (BLOCKED.test(error.message)) blocked = error.message;
      }
      done += 1;
      if (done % 25 === 0 || done === queue.length) {
        process.stdout.write(`${done}/${queue.length} ${summary(counts)}\n`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, queue.length) }, worker));

  for (const line of failures) process.stderr.write(`FAILED ${line}\n`);
  if (blocked) process.stderr.write('STOPPED: YouTube is refusing downloads. Run again later to resume.\n');
  process.stdout.write(`done: ${done}/${queue.length} ${summary(counts)}\n`);
  process.exitCode = counts.failed > 0 || blocked ? 1 : 0;
}

const summary = (counts) => Object.entries(counts).map(([key, n]) => `${key}=${n}`).join(' ');

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
