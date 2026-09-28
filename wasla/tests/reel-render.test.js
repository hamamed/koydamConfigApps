import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createCanvas } from '@napi-rs/canvas';

import { drawPost, REEL_SECONDS, REEL_TIMELINE } from '../public/js/post-draw.js';
import { renderReel } from '../src/reel-render.js';

const post = { title: 'حيوانات', clue: '', letters: 4, image: '/x', credit: 'A · CC0', site: 'chabbek.com', store: false };

/** How many pixels of a frame differ from the bare ground. */
function inked(t) {
  const canvas = createCanvas(108, 192);
  const ctx = canvas.getContext('2d');
  ctx.scale(0.1, 0.1);
  drawPost(ctx, 1080, 1920, post, { icon: null, picture: null, badge: null, showCredit: true }, t);
  return canvas.data();
}

test('a reel starts on the bare ground, and ends on the still post', () => {
  const ground = inked(-1);
  assert.deepEqual(inked(0), ground, 'the first frame is the background alone');
  const last = Math.max(...Object.values(REEL_TIMELINE).map((p) => p.at + p.for + (p.step ?? 0) * 12));
  assert.ok(last < REEL_SECONDS - 3, 'the post holds still for a few seconds to be read');
  assert.deepEqual(inked(REEL_SECONDS - 0.1), inked(null), 'the end is exactly the story image');
  assert.notDeepEqual(inked(1.2), inked(null), 'in between, pieces are still arriving');
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('the reel is an MP4 the Reels APIs take', { skip: !hasFfmpeg && 'ffmpeg is not installed here' }, async () => {
  const file = path.join(os.tmpdir(), `wasla-reel-${process.pid}.mp4`);
  try {
    await renderReel(post, file);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,pix_fmt,r_frame_rate,sample_rate',
      '-show_entries', 'format=duration', '-of', 'json', file], { encoding: 'utf8' });
    const info = JSON.parse(probe.stdout);
    const video = info.streams.find((s) => s.codec_name === 'h264');
    const audio = info.streams.find((s) => s.codec_name === 'aac');
    assert.deepEqual([video.width, video.height, video.pix_fmt, video.r_frame_rate], [1080, 1920, 'yuv420p', '30/1']);
    assert.equal(audio.sample_rate, '48000');
    assert.ok(Math.abs(Number(info.format.duration) - REEL_SECONDS) < 0.2);
    // The index at the front (faststart): Meta can start reading before the end arrives.
    const head = fs.readFileSync(file).subarray(0, 64 * 1024).toString('latin1');
    assert.ok(head.indexOf('moov') !== -1 && head.indexOf('moov') < head.indexOf('mdat'));
  } finally {
    fs.rmSync(file, { force: true });
  }
});
