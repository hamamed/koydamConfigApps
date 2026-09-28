/**
 * The reel: «منشور اليوم»'s story, animated — the ground alone, then each piece
 * arriving from its own side (public/js/post-draw.js, REEL_TIMELINE), then the
 * post held still to be read. Frames are drawn on the server's canvas and piped
 * raw into ffmpeg, which makes the MP4 the Reels APIs take: H.264, yuv420p,
 * 30 fps, 1080 × 1920, the index at the front, and a silent AAC track, since
 * some players and checks expect a sound track to be there.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

import { createCanvas } from '@napi-rs/canvas';

import { drawPost, REEL_SECONDS } from '../public/js/post-draw.js';
import { loadAssets } from './post-render.js';

export const REEL_SIZE = [1080, 1920];
export const REEL_FPS = 30;
/** When the post is whole: the frame Instagram shows as the reel's cover. */
export const REEL_COVER_MS = 6000;

const FFMPEG_ARGS = (file) => [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${REEL_SIZE[0]}x${REEL_SIZE[1]}`, '-r', String(REEL_FPS), '-i', 'pipe:0',
  '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
  '-shortest',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
  '-g', String(REEL_FPS * 2), '-bf', '0',
  '-c:a', 'aac', '-b:a', '128k',
  '-movflags', '+faststart',
  file,
];

/** One reel at a time: a few seconds of all four cores, and the server has players to serve. */
let queue = Promise.resolve();

/** Writes the reel of `post` to `file` (MP4). Resolves when ffmpeg has finished it. */
export function renderReel(post, file, { picturePath = null, showCredit = true, ffmpeg = 'ffmpeg' } = {}) {
  const job = queue.then(() => encode(post, file, { picturePath, showCredit, ffmpeg }));
  queue = job.catch(() => {});
  return job;
}

async function encode(post, file, { picturePath, showCredit, ffmpeg }) {
  const assets = await loadAssets(post, { picturePath, showCredit });
  const canvas = createCanvas(REEL_SIZE[0], REEL_SIZE[1]);
  const ctx = canvas.getContext('2d');
  const temp = `${file}.${process.pid}.tmp.mp4`;

  const child = spawn(ffmpeg, FFMPEG_ARGS(temp), { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const finished = new Promise((resolve, reject) => {
    child.on('error', (err) => reject(new Error(`ffmpeg could not start: ${err.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${stderr.trim().slice(-300)}`))));
  });
  // A failed ffmpeg closes its input; the write error is reported by `finished`.
  child.stdin.on('error', () => {});

  try {
    const frames = REEL_SECONDS * REEL_FPS;
    for (let i = 0; i < frames; i++) {
      drawPost(ctx, REEL_SIZE[0], REEL_SIZE[1], post, assets, i / REEL_FPS);
      // Waits for ffmpeg to take each frame, which also lets the server answer requests between frames.
      if (!child.stdin.write(canvas.data())) await new Promise((resolve) => child.stdin.once('drain', resolve));
      if (child.exitCode !== null) break;
    }
    child.stdin.end();
    await finished;
    fs.renameSync(temp, file);
  } catch (err) {
    child.kill('SIGKILL');
    fs.rmSync(temp, { force: true });
    throw err;
  }
  return file;
}
