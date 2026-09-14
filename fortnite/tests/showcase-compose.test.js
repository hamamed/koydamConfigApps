import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLIP_FRAME, footageClipArgs, renderedClipArgs } from '../scripts/showcase/compose.js';

const argAfter = (args, flag) => args[args.indexOf(flag) + 1];

test('clips are 3:4, the shape of the app detail box and the panel card', () => {
  assert.deepEqual(CLIP_FRAME, { width: 720, height: 960 });
});

test('a footage clip is the crop scaled to the frame, from the chosen seconds, silent', () => {
  const args = footageClipArgs('/work/source.mp4', { x: 1186, y: 0, width: 752, height: 1004 }, { start: 2, duration: 12 }, '/work/clip.mp4');

  assert.equal(argAfter(args, '-ss'), '2');
  assert.equal(argAfter(args, '-t'), '12');
  assert.equal(argAfter(args, '-i'), '/work/source.mp4');
  assert.match(argAfter(args, '-vf'), /^crop=752:1004:1186:0,scale=720:960/);
  assert.ok(args.includes('-an'));
  assert.equal(args.at(-1), '/work/clip.mp4');
});

test('a footage clip has no fades, so it loops like a GIF', () => {
  const args = footageClipArgs('/s.mp4', { x: 0, y: 0, width: 752, height: 1004 }, { start: 0, duration: 10 }, '/o.mp4');

  assert.equal(args.join(' ').includes('fade'), false);
});

test('a rendered clip zooms in and back out over its length, so its last frame meets its first', () => {
  const args = renderedClipArgs({ page: '/w/page.png', art: '/w/art.png' }, { x: 41, y: 41, width: 638, height: 878 }, '/w/clip.mp4');
  const filter = argAfter(args, '-filter_complex');

  assert.match(filter, /cos\(2\*PI\*t\/6\)/);
  assert.equal(filter.includes('fade'), false);
  assert.ok(filter.includes('overlay'));
  assert.ok(args.includes('-an'));
  assert.equal(args.at(-1), '/w/clip.mp4');
});
