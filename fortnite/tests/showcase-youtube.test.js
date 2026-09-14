import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PERMITTED_CHANNELS, clipTiming, cropSize, cropWindow, fitCrop, isPermittedChannel, isInside, motionCenter,
  parseMotionBox,
} from '../scripts/showcase/youtube.js';

test('clipTiming takes twelve seconds from two seconds in when the video is long enough', () => {
  assert.deepEqual(clipTiming(20.5), { start: 2, duration: 12 });
});

test('clipTiming starts earlier for a short video instead of running past its end', () => {
  assert.deepEqual(clipTiming(13), { start: 1, duration: 12 });
  assert.deepEqual(clipTiming(10), { start: 0, duration: 10 });
});

test('clipTiming refuses a video too short to make a clip, or one with no duration', () => {
  assert.equal(clipTiming(5), null);
  assert.equal(clipTiming(Number.NaN), null);
  assert.equal(clipTiming(undefined), null);
});

test('fitCrop uses the full usable height when the source is wide enough', () => {
  assert.deepEqual(fitCrop({ width: 638, height: 939 }, 1004, 1920), { width: 682, height: 1004 });
});

test('fitCrop keeps a narrow, portrait source inside its own frame', () => {
  const crop = fitCrop({ width: 638, height: 939 }, 1004, 608);

  assert.equal(crop.width, 608);
  assert.ok(crop.height <= 1004);
  assert.equal(crop.height % 2, 0);
});

test('isInside only accepts a file within the given directory', () => {
  assert.equal(isInside('/tmp/work/source.mp4', '/tmp/work'), true);
  assert.equal(isInside('/tmp/work/../elsewhere.mp4', '/tmp/work'), false);
  assert.equal(isInside('/tmp/workshop/source.mp4', '/tmp/work'), false);
});

const CROPDETECT_LOG = `
[Parsed_cropdetect_3 @ 0x1] x1:1400 x2:1500 y1:1004 y2:0 w:100 h:-1003 x:1400 y:1004 pts:10 t:0.33 limit:0.12 crop=100:-1003:1400:1004
[Parsed_cropdetect_3 @ 0x1] x1:1322 x2:1732 y1:1004 y2:0 w:410 h:-1003 x:1322 y:1004 pts:360 t:12.0 limit:0.12 crop=410:-1003:1322:1004
`;

test('parseMotionBox reads the last, widest box ffmpeg reported', () => {
  assert.deepEqual(parseMotionBox(CROPDETECT_LOG), { x1: 1322, x2: 1732, y1: 1004, y2: 0 });
});

test('parseMotionBox returns null when nothing moved or nothing was reported', () => {
  assert.equal(parseMotionBox(''), null);
  assert.equal(parseMotionBox('[Parsed_cropdetect_3 @ 0x1] x1:1919 x2:0 y1:1004 y2:0 w:-1918'), null);
});

test('motionCenter is the middle of the moving area, or null without one', () => {
  assert.equal(motionCenter({ x1: 1322, x2: 1732 }), 1527);
  assert.equal(motionCenter(null), null);
});

test('cropSize keeps the card shape at the height above the creator banner', () => {
  assert.deepEqual(cropSize({ width: 638, height: 939 }, 1005), { width: 682, height: 1005 });
});

test('cropWindow centres on the skin and never leaves the frame', () => {
  assert.equal(cropWindow(1527, 1920, 682), 1186);
  assert.equal(cropWindow(100, 1920, 682), 0);
  assert.equal(cropWindow(1900, 1920, 682), 1238);
});

test('cropWindow falls back to the middle of the frame when no motion was found', () => {
  assert.equal(cropWindow(null, 1920, 682), 618);
});

test('only channels that gave permission are used', () => {
  assert.equal(isPermittedChannel('Gnejs Gaming'), true);
  assert.equal(isPermittedChannel('Some Other Channel'), false);
  assert.equal(isPermittedChannel(''), false);
  assert.equal(isPermittedChannel(undefined), false);
  assert.ok(Object.isFrozen(PERMITTED_CHANNELS));
});
